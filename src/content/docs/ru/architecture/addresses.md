---
title: Адреса Tron и Ethereum в 2D
description: "Один 20-байтный аккаунт, две линии кодирования: как 2D показывает TronLink и MetaMask один и тот же баланс."
---

Адрес Ethereum выглядит так: `0xf39Fd6…`. Адрес Tron: `TR7NHq…`. Разные алфавиты, разные контрольные суммы, разные экосистемы. На первый взгляд, это две совершенно разные вещи.

На самом деле это не так. Под обеими строками скрывается **один и тот же 20-байтный аккаунт**, полученный одинаковым образом из открытого ключа secp256k1. Всё, что их различает: префикс `0x` или `T`, чередование заглавных и строчных букв, а также алфавит Base58. Все эти отличия существуют лишь на уровне кодирования поверх базовых 20 байт.

Сеть 2D хранит аккаунты в едином 20-байтном формате и предоставляет их вовне в любом из двух представлений. Перевод, отправленный из TronLink, поступает на тот же аккаунт, который MetaMask затем видит через вызов `eth_getBalance`. В этой статье мы разберем: как формируется сам 20-байтный адрес, две формы его записи (EIP-55 hex и Base58Check) и где именно в коде (`lib/chain/`) сеть определяет, какой из форматов был передан на вход.

## Общий фундамент

Как в Ethereum, так и в Tron адрес аккаунта генерируется из **открытого ключа secp256k1**:

```
account = keccak256(uncompressed_pubkey_without_prefix)[-20..]
```

Двадцать байт. Одна и та же формула, одинаковое распределение битов. Единственное различие между `0x…` и `T…` заключается в выборе формата записи поверх этих двадцати байт.

В 2D это реализовано в функции [`Chain.Crypto.recover_tron_sender/2`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/crypto.ex#L28-L53): подпись Tron восстанавливается в те же самые 20 байт, что и подпись Ethereum.

## Форма №1: Ethereum, hex + EIP-55

Адрес Ethereum представляет собой **20 байт в шестнадцатеричном (hex) формате** с контрольной суммой, закодированной в регистре символов.

- Внешний вид: префикс `0x` и 40 hex-символов.
- Стандарт [EIP-55](https://eips.ethereum.org/EIPS/eip-55) использует **регистр** каждого hex-символа в качестве одного бита контрольной суммы: если соответствующий полубайт (ниббл) в хеше `keccak256(lowercase_hex)` ≥ 8, символ переводится в верхний регистр.

В этом формате больше ничего нет: ни байта версии, ни отдельных байт контрольной суммы. Проверка сводится к следующему: длина строки должна составлять 42 символа, а чередование заглавных и строчных букв должно совпадать с результатом `keccak256(lowercase)`. См. реализацию в [`Chain.Crypto.encode_address/1`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/crypto.ex#L380-L397):

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

## Форма №2: Tron, Base58Check с байтом версии

Tron унаследовал формат **Base58Check от Bitcoin**, добавив собственный префикс:

1. К 20-байтной полезной нагрузке (payload) слева добавляется **байт версии `0x41`** — метка основной сети (mainnet) Tron (в Bitcoin на этой позиции находится `0x00`). В результате получается 21 байт: `0x41 || addr`.
2. Вычисляется **4-байтная контрольная сумма**: `sha256(sha256(payload))[:4]`. Используется именно *двойное* хеширование SHA-256, как в Bitcoin.
3. Итоговая строка `payload || checksum` длиной 25 байт **кодируется в формат Base58**.

Поскольку первый байт полезной нагрузки всегда равен `0x41`, после кодирования в Base58 любой адрес Tron начинается с буквы **`T`**. Отсюда и происходит формат `T…`.

См. реализацию в [`Chain.Tron.Address.encode/1`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/tron/address.ex#L31-L38) и [`Base58.encode/1`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/tron/base58.ex#L10-L22):

```elixir
def encode(<<_::binary-20>> = address) do
  payload = <<@mainnet_version>> <> address
  checksum = :binary.part(:crypto.hash(:sha256, :crypto.hash(:sha256, payload)), 0, 4)
  Base58.encode(payload <> checksum)
end
```

Проверка (функция [`validate_check/1`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/tron/address.ex#L70-L88)) выполняется в обратном порядке: декодировать Base58 → отсечь контрольную сумму → заново вычислить двойной SHA-256 от полезной нагрузки → сравнить полученные 4 байта.

### Сравнение контрольных сумм

| Характеристика | Ethereum (EIP-55) | Tron (Base58Check) |
|---|---|---|
| Хеш-функция | `keccak256` (от *строчной* hex-строки) | `sha256(sha256(…))` (от сырых байт) |
| Размер контрольной суммы | 0 байт отдельно (закодирована в регистре символов) | 4 байта, добавляются перед кодированием в Base58 |
| Алфавит | `0-9a-fA-F` | Base58: `123456789ABCDEFGHJKLMN…` (исключены символы `0`, `O`, `I`, `l`) |
| Механизм выявления опечаток | Бит регистра для каждого hex-символа | Любое изменение байта нарушает контрольную сумму |
| Длина при передаче (on-wire) | 42 символа (`0x` + 40) | 34 символа (обычно) |

Несмотря на разные подходы, цель у них одна: предотвратить подписание транзакции с ошибочно введенным адресом.

## Как 2D обрабатывает оба формата

HTTP API `/wallet/*` в сети 2D принимает **четыре формата адресов на сетевом уровне**, и все они преобразуются в один и тот же 20-байтный аккаунт:

| Формат | Пример | Процесс декодирования в 2D |
|---|---|---|
| Tron Base58Check | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | `Base58.decode` → проверка `validate_check` → удаление префикса `0x41` → 20 байт |
| 21-байтный hex с `0x` | `0x41…` (42 hex-символа / 44 символа всего) | удаление `0x` → декодирование hex → проверка первого байта `0x41` → извлечение последних 20 байт |
| Сырой 21-байтный hex | `41…` (42 hex-символа / 42 символа всего) | декодирование hex → проверка первого байта `0x41` → извлечение последних 20 байт |
| Ethereum 20-байтный hex | `0xf39Fd6…` (40 hex-символов / 42 символа всего) | удаление `0x` → декодирование hex → 20 байт |

Вся логика маршрутизации реализована в функции [`Chain.Tron.Wallet.parse_address_param/2`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/tron/wallet.ex#L674-L695):

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

Условие «префикс `0x` и длина 42» позволяет сразу отфильтровать адреса Ethereum на входе. Все остальные форматы (`T…`, `41…`, `0x41…`) передаются в функцию [`Chain.Tron.Address.decode/1`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/tron/address.ex#L40-L61), которая единообразно обрабатывает три оставшихся представления Tron.

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

Сеть хранит 20-байтный ключ в единственном экземпляре. Каждый RPC-обработчик выполняет декодирование на входе и кодирование на выходе. Кошельки TronLink и MetaMask не знают о существовании друг друга, однако оба отображают один и тот же баланс, единый nonce и видят транзакции, отправленные из любой экосистемы.

## Дополнительно

- [EIP-55: Mixed-case checksum address encoding](https://eips.ethereum.org/EIPS/eip-55)
- [Протокол Tron: формат адреса](https://developers.tron.network/docs/account)
- [Определение Base58Check от Сатоши в Bitcoin Core](https://github.com/bitcoin/bitcoin/blob/master/src/base58.h)
- Исходники 2D: [`lib/chain/tron/address.ex`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/tron/address.ex), [`lib/chain/tron/base58.ex`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/tron/base58.ex), [`lib/chain/crypto.ex`](https://github.com/igor53627/2d/blob/4d955b70efde1075e316d9ab2c2c10820fb0cd71/lib/chain/crypto.ex)
