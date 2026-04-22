---
title: Tron & Ethereum addresses in 2D
description: One 20-byte account, two encoding lineages — how 2D makes TronLink and MetaMask see the same balance.
---

An Ethereum address looks like `0xf39Fd6…`. A Tron address looks like `TR7NHq…`. Different alphabets, different checksums, different ecosystems — on sight they feel like two unrelated things.

They aren't. Underneath both strings is the **same 20-byte account**, derived the same way from a secp256k1 public key. Everything else — the `0x` or `T` prefix, the case pattern, the Base58 alphabet — lives in the encoding layer wrapping those 20 bytes on the way out.

2D is a chain that stores accounts in that shared 20-byte form and renders them in either dialect on demand. A transfer sent from TronLink lands in the same account MetaMask reads through `eth_getBalance`. This article walks through it in order: how the 20-byte address is derived, the two encoding schemes (EIP-55 checksummed hex and Base58Check), and where in `lib/chain/` the chain figures out which form it was handed.

## The shared foundation

Ethereum and Tron both derive an account from a **secp256k1 public key**:

```
account = keccak256(uncompressed_pubkey_without_prefix)[-20..]
```

Twenty bytes. Same derivation, same bit layout. Every downstream difference between `0x…` and `T…` is a packaging choice on top of this.

In 2D, this is [`Chain.Crypto.recover_tron_sender/2`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex#L25-L44): a Tron signature recovers to the exact same 20 bytes an Ethereum signature would.

## Packaging #1 — Ethereum (EIP-55 checksummed hex)

Ethereum addresses are just **hex-encoded 20 bytes** with a case-based checksum layered on top:

- The display form is `0x` + 40 hex characters.
- [EIP-55](https://eips.ethereum.org/EIPS/eip-55) uses the **case** of each hex character as a per-character checksum bit: if the corresponding nibble of `keccak256(lowercase_hex)` is `≥ 8`, the character is uppercased.

That's the entire format. No version byte, no separate checksum bytes. Validation is: length == 42, case-mixed, and the case pattern matches `keccak256(lowercase)`. See [`Chain.Crypto.encode_address/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex#L323-L340):

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

## Packaging #2 — Tron (version-prefixed Base58Check)

Tron inherits the **Bitcoin Base58Check** address format, customised:

1. **Prefix the 20-byte payload with the version byte `0x41`** — Tron mainnet's equivalent of Bitcoin's `0x00`. The payload becomes 21 bytes: `0x41 || addr`.
2. **Compute a 4-byte checksum**: `sha256(sha256(payload))[:4]`. That's *double* SHA-256, same as Bitcoin.
3. **Base58-encode** the 25-byte string `payload || checksum`.

Because `0x41` is always the first byte of the payload, the result always starts with **`T`** when Base58-encoded. That's where `T…` comes from.

See [`Chain.Tron.Address.encode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L8-L13) and [`Base58.encode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/base58.ex#L9-L20):

```elixir
def encode(<<_::binary-20>> = address) do
  payload = <<@mainnet_version>> <> address
  checksum = :binary.part(:crypto.hash(:sha256, :crypto.hash(:sha256, payload)), 0, 4)
  Base58.encode(payload <> checksum)
end
```

Validation ([`validate_check/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L48-L64)) reverses the process: Base58-decode → strip checksum → double-SHA the payload → compare.

### The two checksums side by side

| | Ethereum (EIP-55) | Tron (Base58Check) |
|---|---|---|
| Hash used | `keccak256` (of the lowercase hex string!) | `sha256(sha256(…))` (of the raw bytes) |
| Checksum size | 0 bytes on the wire (encoded in case) | 4 bytes appended before Base58 |
| Alphabet | `0-9a-fA-F` | Base58 — `123456789ABCDEFGHJKLMN…` (no `0`, no `O`, no `I`, no `l`) |
| Typo detection | Per-character case bit | Any single-byte change fails the 4-byte check |
| Total on-wire length | 42 chars (`0x` + 40) | 34 chars (typical) |

Different families, same goal — catch mistyped addresses before you sign a transaction to them.

## How 2D accepts both

2D's `/wallet/*` surface accepts **four on-wire address forms**, all resolving to the same 20-byte key:

| Form | Example | How 2D decodes it |
|---|---|---|
| Tron Base58Check | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | Strip `T…` → `Base58.decode` → `validate_check` → drop 0x41 → 20 bytes |
| 0x-prefixed 21-byte hex | `0x41…` (42 hex chars) | Strip `0x` → decode hex → assert first byte is `0x41` → keep last 20 bytes |
| Raw 21-byte hex | `41…` (42 hex chars) | Decode hex directly → assert `0x41` prefix → keep last 20 bytes |
| Ethereum 20-byte hex | `0xf39Fd6…` (42 hex chars) | Strip `0x` → decode hex → keep all 20 bytes |

The dispatcher is [`Chain.Tron.Wallet.parse_address_param/2`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/wallet.ex#L647-L667):

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

The `0x…` + length-42 branch peels off Ethereum addresses early. Everything else — `T…`, `41…`, `0x41…` — falls through to [`Chain.Tron.Address.decode/1`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex#L15-L35), which handles all three Tron forms uniformly.

## One key, two worlds

```
                       secp256k1 private key
                              │
                              ▼
                 uncompressed public key (64 bytes)
                              │
                              ▼
                keccak256(pubkey)[-20..]  ─── the 20-byte account
                  │                    │
                  │                    │
                  ▼                    ▼
        ┌──────────────┐      ┌────────────────────┐
        │  Ethereum    │      │       Tron         │
        │              │      │                    │
        │  0x + hex    │      │  prefix 0x41       │
        │  + EIP-55    │      │  + sha256·sha256   │
        │  case-check  │      │  + Base58          │
        └──────┬───────┘      └──────────┬─────────┘
               │                         │
               ▼                         ▼
        0xf39Fd6e5…                TR7NHqjeKQ…
```

The chain stores the 20-byte key once. Every RPC handler decodes on the way in, encodes on the way out. Neither TronLink nor MetaMask notice the other exists — but both see the same balance, the same nonce, and each other's transactions.

## Further reading

- [EIP-55 — Mixed-case checksum address encoding](https://eips.ethereum.org/EIPS/eip-55)
- [Tron protocol — Tron Address Format](https://developers.tron.network/docs/account)
- [Satoshi's original Base58Check definition in Bitcoin Core](https://github.com/bitcoin/bitcoin/blob/master/src/base58.h)
- 2D source: [`lib/chain/tron/address.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/address.ex), [`lib/chain/tron/base58.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/tron/base58.ex), [`lib/chain/crypto.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/crypto.ex)
