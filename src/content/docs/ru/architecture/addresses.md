---
title: Адреса Tron и Ethereum в 2D
description: Один 20-байтный аккаунт, два семейства кодировок — как 2D делает так, чтобы TronLink и MetaMask видели один и тот же баланс.
---

Когда вы впервые открываете TronLink, подключённый к узлу 2D, и обращаетесь к `/wallet/getaccount`, в ответе приходит строка вида `T…`. Запросите тот же баланс через MetaMask, через `eth_getBalance`, и вы получите адрес вида `0x…`. Это **один и тот же аккаунт** — не копия, не зеркало. Это две на-проводные кодировки одного 20-байтного первичного ключа, который сеть хранит в единственном экземпляре.

В этой статье разберём, почему существуют обе кодировки, что у них общего, что различает, и где в `lib/chain/` происходит согласование.

## Общее основание

И Ethereum, и Tron выводят адрес аккаунта из **открытого ключа secp256k1**:

```
account = keccak256(uncompressed_pubkey_without_prefix)[-20..]
```

Двадцать байт. Одинаковое вычисление, одинаковое расположение битов. Любое отличие между `0x…` и `T…` — это выбор упаковки поверх этого результата.

В 2D это реализовано в [`Chain.Crypto.recover_tron_sender/2`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex#L25-L44): подпись Tron восстанавливается в те же 20 байт, что и подпись Ethereum.

## Упаковка №1 — Ethereum (EIP-55 checksummed hex)

Адреса Ethereum — это просто **20 байт в шестнадцатеричном виде** с контрольной суммой на основе регистра:

- Отображаемая форма: `0x` + 40 шестнадцатеричных символов.
- [EIP-55](https://eips.ethereum.org/EIPS/eip-55) использует **регистр** каждого hex-символа как бит контрольной суммы: если соответствующий ниббл в `keccak256(lowercase_hex)` ≥ 8, символ становится заглавным.

Это и есть весь формат. Нет байта версии, нет отдельных байтов контрольной суммы. Проверка: длина 42, смешанный регистр, и узор регистра совпадает с `keccak256(lowercase)`. См. [`Chain.Crypto.encode_address/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex#L323-L340):

```elixir
def encode_address(<<address::binary-20>>) do
  hex = Base.encode16(address, case: :lower)
  hash = keccak256(hex) |> Base.encode16(case: :lower)

  checksummed =
    hex
    |> String.graphemes()
    |> Enum.zip(String.graphemes(hash))
    |> Enum.map(fn {char, h} ->
      {h_int, _} = Integer.parse(h, 16)
      if h_int >= 8, do: String.upcase(char), else: char
    end)
    |> Enum.join()

  "0x" <> checksummed
end
```

## Упаковка №2 — Tron (версионный Base58Check)

Tron наследует формат **Base58Check из Bitcoin** с небольшими отличиями:

1. **К 20-байтной полезной нагрузке прибавляется байт версии `0x41`** — эквивалент биткойновского `0x00` для основной сети Tron. Полезная нагрузка становится 21-байтной: `0x41 || addr`.
2. **Вычисляется 4-байтная контрольная сумма**: `sha256(sha256(payload))[:4]`. Это *двойной* SHA-256, как и в Bitcoin.
3. **Полученная 25-байтная строка** `payload || checksum` **кодируется в Base58**.

Поскольку `0x41` всегда первый байт полезной нагрузки, результат после Base58-кодирования всегда начинается с **`T`**. Отсюда и `T…`.

См. [`Chain.Tron.Address.encode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L8-L13) и [`Base58.encode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/base58.ex#L9-L20):

```elixir
def encode(<<_::binary-20>> = address) do
  payload = <<@mainnet_version>> <> address
  checksum = :binary.part(:crypto.hash(:sha256, :crypto.hash(:sha256, payload)), 0, 4)
  Base58.encode(payload <> checksum)
end
```

Проверка ([`validate_check/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L48-L64)) реверсирует процесс: декодирование Base58 → отбрасывание контрольной суммы → двойной SHA-256 на полезной нагрузке → сравнение.

### Две контрольные суммы бок о бок

| | Ethereum (EIP-55) | Tron (Base58Check) |
|---|---|---|
| Используемый хэш | `keccak256` (от строчной hex-строки!) | `sha256(sha256(…))` (от сырых байтов) |
| Размер контрольной суммы | 0 байт на проводе (закодировано в регистре) | 4 байта добавляются перед Base58 |
| Алфавит | `0-9a-fA-F` | Base58 — `123456789ABCDEFGHJKLMN…` (нет `0`, `O`, `I`, `l`) |
| Обнаружение опечатки | Бит регистра на каждый символ | Любое однобайтное изменение ломает 4-байтную проверку |
| Итоговая длина на проводе | 42 символа (`0x` + 40) | 34 символа (типично) |

Разные семейства, одинаковая цель — поймать опечатку раньше, чем вы подпишете транзакцию не по тому адресу.

## Как 2D принимает оба формата

Поверхность `/wallet/*` в 2D принимает **четыре формата адреса на проводе**, все разрешаются в один и тот же 20-байтный ключ:

| Формат | Пример | Как 2D декодирует |
|---|---|---|
| Tron Base58Check | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | Оставить `T…` → `Base58.decode` → `validate_check` → отбросить 0x41 → 20 байт |
| 21-байтный hex с префиксом `0x` | `0x41…` (42 hex-символа) | Убрать `0x` → декодировать hex → проверить, что первый байт — `0x41` → оставить последние 20 байт |
| Сырой 21-байтный hex | `41…` (42 hex-символа) | Декодировать hex напрямую → проверить префикс `0x41` → оставить последние 20 байт |
| Ethereum 20-байтный hex | `0xf39Fd6…` (42 hex-символа) | Убрать `0x` → декодировать hex → оставить все 20 байт |

Диспетчер — [`Chain.Tron.Wallet.parse_address_param/2`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/wallet.ex#L647-L667):

```elixir
defp parse_address_param(params, key) do
  case Map.get(params, key) do
    nil ->
      {:error, "missing #{key}"}

    addr when is_binary(addr) ->
      cond do
        String.starts_with?(addr, "0x") and byte_size(addr) == 42 ->
          case Crypto.decode_address_safe(addr) do
            {:ok, a} -> {:ok, a}
            {:error, _} -> {:error, "invalid #{key}"}
          end

        true ->
          case Address.decode(addr) do
            {:ok, a} -> {:ok, a}
            {:error, _} -> {:error, "invalid #{key}"}
          end
      end
  end
end
```

Ветка `0x…` + длина 42 отсекает адреса Ethereum на входе. Всё остальное — `T…`, `41…`, `0x41…` — попадает в [`Chain.Tron.Address.decode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L15-L35), который единообразно обрабатывает все три формата Tron.

## Один ключ, два мира

```
                       приватный ключ secp256k1
                              │
                              ▼
                 открытый ключ (64 байта)
                              │
                              ▼
                keccak256(pubkey)[-20..]  ─── 20-байтный аккаунт
                  │                    │
                  │                    │
                  ▼                    ▼
        ┌──────────────┐      ┌────────────────────┐
        │   Ethereum   │      │        Tron        │
        │              │      │                    │
        │  0x + hex    │      │  префикс 0x41      │
        │  + EIP-55    │      │  + sha256·sha256   │
        │  регистр     │      │  + Base58          │
        └──────┬───────┘      └──────────┬─────────┘
               │                         │
               ▼                         ▼
        0xf39Fd6e5…                TR7NHqjeKQ…
```

Сеть хранит 20-байтный ключ один раз. Каждый RPC-обработчик декодирует на входе и кодирует на выходе. Ни TronLink, ни MetaMask не знают о существовании другого — но оба видят один и тот же баланс, один и тот же nonce, и транзакции друг друга.

## Дополнительно

- [EIP-55 — Mixed-case checksum address encoding](https://eips.ethereum.org/EIPS/eip-55)
- [Tron protocol — Tron Address Format](https://developers.tron.network/docs/account)
- [Определение Base58Check от Сатоши в Bitcoin Core](https://github.com/bitcoin/bitcoin/blob/master/src/base58.h)
- Исходники 2D: [`lib/chain/tron/address.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex), [`lib/chain/tron/base58.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/base58.ex), [`lib/chain/crypto.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex)
