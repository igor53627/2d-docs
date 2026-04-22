---
title: Адреса Tron и Ethereum в 2D
description: Один 20-байтный аккаунт, две линии кодирования — как 2D показывает TronLink и MetaMask один и тот же баланс.
---

Адрес Ethereum выглядит так: `0xf39Fd6…`. Адрес Tron — так: `TR7NHq…`. Разные алфавиты, разные чек-суммы, разные экосистемы — на вид это две разные вещи.

На деле — нет. Под обеими строками прячется **один и тот же 20-байтный аккаунт**, полученный одинаково из открытого ключа secp256k1. Всё, что их различает — префикс `0x` или `T`, чередование заглавных и строчных, алфавит Base58 — живёт в слое кодирования поверх этих 20 байт.

2D — это сеть, которая хранит аккаунты в общем 20-байтном виде и отдаёт их наружу в любом из двух форматов. Перевод, отправленный из TronLink, попадает в тот же аккаунт, который MetaMask потом находит через `eth_getBalance`. В статье разбираемся по порядку: как получается сам 20-байтный адрес, две формы его записи (EIP-55 hex и Base58Check), и где в `lib/chain/` сеть решает, какая из форм пришла на вход.

## Общий фундамент

И в Ethereum, и в Tron адрес аккаунта получается из **открытого ключа secp256k1**:

```
account = keccak256(uncompressed_pubkey_without_prefix)[-20..]
```

Двадцать байт. Одна и та же формула, одна раскладка битов. Всё, что различает `0x…` и `T…`, — это выбор формы записи поверх этих двадцати байт.

В 2D это реализовано в [`Chain.Crypto.recover_tron_sender/2`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex#L25-L44): подпись Tron восстанавливается ровно в те же 20 байт, что и подпись Ethereum.

## Форма №1 — Ethereum: hex + EIP-55

Адрес Ethereum — это **20 байт в hex-виде** с чек-суммой, закодированной в регистре букв:

- Внешний вид: `0x` + 40 hex-символов.
- [EIP-55](https://eips.ethereum.org/EIPS/eip-55) использует **регистр** каждого hex-символа как один бит чек-суммы: если соответствующий ниббл в `keccak256(lowercase_hex)` ≥ 8, символ поднимается в заглавный.

Больше в формате ничего нет. Ни байта версии, ни отдельных байт чек-суммы. Проверка одна: длина 42, смешанный регистр, и чередование заглавных и строчных совпадает с `keccak256(lowercase)`. См. [`Chain.Crypto.encode_address/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex#L323-L340):

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

## Форма №2 — Tron: Base58Check с байтом версии

Tron унаследовал формат **Base58Check от Bitcoin** и добавил свой byte-prefix:

1. К 20-байтному payload слева приписывается **байт версии `0x41`** — метка mainnet Tron (в Bitcoin в этой же позиции стоит `0x00`). Получается 21 байт: `0x41 || addr`.
2. Считается **4-байтная чек-сумма**: `sha256(sha256(payload))[:4]`. Именно *двойной* SHA-256, как в Bitcoin.
3. Итоговая строка `payload || checksum` длиной 25 байт **кодируется в Base58**.

Первый байт payload всегда `0x41`, поэтому после Base58 любой Tron-адрес начинается с **`T`**. Отсюда и `T…`.

См. [`Chain.Tron.Address.encode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L8-L13) и [`Base58.encode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/base58.ex#L9-L20):

```elixir
def encode(<<_::binary-20>> = address) do
  payload = <<@mainnet_version>> <> address
  checksum = :binary.part(:crypto.hash(:sha256, :crypto.hash(:sha256, payload)), 0, 4)
  Base58.encode(payload <> checksum)
end
```

Проверка ([`validate_check/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L48-L64)) идёт обратным путём: раскодировать Base58 → отсечь чек-сумму → пересчитать двойной SHA-256 по payload → сравнить 4 байта.

### Сравнение чек-сумм

| | Ethereum (EIP-55) | Tron (Base58Check) |
|---|---|---|
| Хэш | `keccak256` (от *строчной* hex-строки!) | `sha256(sha256(…))` (от сырых байт) |
| Размер чек-суммы | 0 байт отдельно (она в регистре букв) | 4 байта, приклеиваются перед Base58 |
| Алфавит | `0-9a-fA-F` | Base58 — `123456789ABCDEFGHJKLMN…` (нет `0`, `O`, `I`, `l`) |
| Что ловит опечатку | Бит регистра на каждый hex-символ | Любое изменение одного байта рвёт чек-сумму |
| Длина on-wire | 42 символа (`0x` + 40) | 34 символа (типично) |

Подходы разные, цель одна: не дать подписать транзакцию по неверно введённому адресу.

## Как 2D принимает оба формата

HTTP API `/wallet/*` в 2D принимает **четыре формы адреса on-wire**, и все разрешаются в один и тот же 20-байтный ключ:

| Форма | Пример | Как 2D декодирует |
|---|---|---|
| Tron Base58Check | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | `Base58.decode` → `validate_check` → отбросить `0x41` → 20 байт |
| 21-байтный hex с `0x` | `0x41…` (42 символа) | снять `0x` → раскодировать hex → проверить первый байт `0x41` → оставить последние 20 байт |
| Сырой 21-байтный hex | `41…` (42 символа) | раскодировать hex → проверить первый байт `0x41` → оставить последние 20 байт |
| Ethereum 20-байтный hex | `0xf39Fd6…` (42 символа) | снять `0x` → раскодировать hex → 20 байт |

Всю развилку берёт на себя [`Chain.Tron.Wallet.parse_address_param/2`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/wallet.ex#L647-L667):

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

Ветка «префикс `0x` + длина 42» отсекает Ethereum-адреса сразу на входе. Всё остальное — `T…`, `41…`, `0x41…` — уходит в [`Chain.Tron.Address.decode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L15-L35), который единообразно разбирает три оставшиеся формы Tron.

## Один ключ, две экосистемы

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

Сеть хранит 20-байтный ключ один раз. Каждый RPC-обработчик декодирует на входе и кодирует на выходе. Ни TronLink, ни MetaMask не знают о существовании друг друга — но оба видят один баланс, один nonce и транзакции друг друга.

## Дополнительно

- [EIP-55 — Mixed-case checksum address encoding](https://eips.ethereum.org/EIPS/eip-55)
- [Протокол Tron — формат адреса](https://developers.tron.network/docs/account)
- [Определение Base58Check от Сатоши в Bitcoin Core](https://github.com/bitcoin/bitcoin/blob/master/src/base58.h)
- Исходники 2D: [`lib/chain/tron/address.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex), [`lib/chain/tron/base58.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/base58.ex), [`lib/chain/crypto.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex)
