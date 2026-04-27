---
title: Bridge — HTLC settlement и per-event refill
description: Как 2D перемещает USD-stable между сетями без custody-контракта в стиле wrapped-моста, без unlock-полномочий у оператора и без pre-mint trust seed. Preimage-locked settlement плюс верификатор, который перепроверяет каждый refill по finalized Ethereum-стейту.
---

Мосты — крупнейший единичный класс краж в крипте. **С 2020 года из cross-chain мостов украдено более $2.8B, около 40% всего объёма Web3-краж** ([Chainalysis / industry summary](https://www.certik.com/resources/blog/GuBAYoHdhrS1mK9Nyfyto-cross-chain-vulnerabilities-and-bridge-exploits-in-2022)). Только 2026 год дал **больше $750M потерь на мостах меньше чем за четыре месяца** ([Phemex DeFi hacks 2026](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained)). Шаблон у всех катастрофических провалов одинаковый: custody-контракт держит залоченные токены на цепочке A, федерация валидаторов наблюдает за lock-ом и подписывает unlock или mint на цепочке B, и одна скомпрометированная подпись опустошает весь пул.

Bridge у 2D устроен так, чтобы этот шаблон в принципе не воспроизводился. Полномочия `unlock()` нет нигде; settlement идёт через preimage-locked HTLC на обеих сторонах. Pre-mint trust seed нет; supply на стороне 2D стартует с нуля и растёт по одному event-у за раз, и каждый из них независимо перепроверяется по finalized Ethereum-стейту. Единственная роль оператора — matchmaker: залочить что-то, залочить парное на другой стороне, передать пользователю preimage, когда тот появится.

Эта статья проходит по дизайн-выбору (почему HTLC, а не lock-mint), механике refill-mint (как supply отслеживает Ethereum-event-ы 1:1), cross-chain check-у (что верификатор независимо подтверждает) и по trust-модели, которая из этого вытекает.

## Почему не lock-mint

Архитектура моста по умолчанию — это **lock-mint**. Alice отправляет USDC в custody-контракт на цепочке A. Федерация валидаторов наблюдает lock-event и подписывает вызов `mint(Alice, amount)` на wrapped-token контракте цепочки B. Wrapped-токены ходят; в какой-то момент кто-то делает redeem, мост делает симметричный `burn`, и соответствующий `unlock()` на цепочке A высвобождает исходные USDC.

Структурная проблема: финальный `unlock()` безусловный с точки зрения цепочки. Кто угодно с подходящими ключами (порог валидаторов, multisig, кворум oracle-а) может вызвать `unlock()` на любую сумму вплоть до TVL моста, в любой момент. Скомпрометируешь достаточно ключей — весь пул уходит.

Список катастрофических провалов читается как краткая история компрометаций unlock-полномочий:

- **Wormhole** (2022, ~$320M). Кривое использование Solana-хелпера приняло поддельную guardian-подпись и наминтило wETH из ничего.
- **Ronin** (2022, ~$620M). Пять из девяти ключей валидаторов зафишены; атакующий апрувнул два крупных withdrawal-а.
- **Nomad** (2022, ~$190M). Апгрейд случайно обошёл одну проверку, превратив unlock-путь в свободу для всех.
- **Poly Network** (2021, ~$611M). Функцию `lock` cross-chain менеджера можно было обманом заставить вызвать unlock на произвольные суммы.

Разные API, один примитив: кто-то с ключами мог сделать unlock.

2D заменяет lock-mint на **HTLC settlement на обеих сторонах**. Alice залочивает USDC на Ethereum HTLC-контракте под хешем `H` и deadline-ом. Bridge-оператор залочивает эквивалентный USD-stable на 2D HTLC под тем же хешем. Alice делает claim на 2D с помощью preimage `P`, такого что `sha256(P) = H`. Оператор теперь видит `P` на стороне 2D и использует его, чтобы сделать claim исходных USDC на Ethereum.

Unlock-полномочий больше нет. Нет `unlock()`, который мог бы вызвать оператор. Единственная функция на любой из сторон, которая высвобождает средства, — это `claim(preimage)`. Работает только если `sha256(preimage) = hash`, и только до deadline-а. Скомпрометированный ключ оператора ничего не может слить, потому что preimage-ы живут в кошельках пользователей, не у оператора.

Парный `refund(hash)` возвращает средства исходному отправителю, когда deadline проходит без claim-а. Худший сценарий для пользователя — `refund` срабатывает, и деньги возвращаются туда, откуда пришли. Не существует сценария, в котором атакующий уносит TVL.

## Refill-mint и инвариант supply

HTLC-своп на стороне 2D требует, чтобы у оператора была ликвидность для lock-а. Откуда эта ликвидность берётся?

Стандартный ответ wrapped-моста: «pre-mint запас, доверяй оператору, что не сбежит». 2D отказывается от этого доверия. В production на нулевой день в пуле bridge-оператора ноль USD-stable. Получить USD-stable оператор может, только **сославшись на finalized Ethereum lock**: каждый USD-stable, существующий на стороне 2D, соответствует 1:1 проверенному Ethereum `Locked` event-у.

Механизм — одна state-changing функция на precompile `BridgeRefillMint` по адресу `0x2D00…0003` ([`lib/chain/precompiles/bridge_refill_mint.ex`](https://github.com/igor53627/2d/blob/8b7caf2/lib/chain/precompiles/bridge_refill_mint.ex)):

```solidity
refill_mint(uint64 eth_chain_id, bytes32 eth_tx_hash, uint32 eth_log_index, uint256 amount)
```

Calldata — это исходная тройка, идентифицирующая один `Locked` event на Ethereum, плюс заявленный amount. Precompile делает три вещи, по порядку:

1. Отклоняет вызов, если caller не равен сконфигурированному `bridge_operator_address`. Это отдельная роль от genesis minter-а; конфигурация, которая склеивает их в один адрес, падает на старте с явным raise.
2. Вычисляет `eth_event_id = keccak256(eth_chain_id ‖ eth_tx_hash ‖ eth_log_index)` и пытается вставить строку с этим id в ledger `bridge_mints`. Primary key на `eth_event_id` гарантирует, что дубликат тройки не может заминтить дважды.
3. Если insert прошёл, кредитует `amount` в пул оператора и эмитит `BridgeRefillMinted(eth_event_id, operator, amount)`.

Никакого батчинга. Один `refill_mint` на каждый finalized `Locked` event, один event на каждый refill. На бесплатных транзакциях 2D нет экономического давления амортизировать вызовы; вызов на каждый event делает инвариант supply жёстким на каждом блоке.

Форма calldata выбрана намеренно. В раннем дизайне передавался только производный `eth_event_id` в виде одного `bytes32`. Это делало id необратимым в момент проверки: верификатору нужна исходная тройка `(chain_id, tx_hash, log_index)`, чтобы спросить Ethereum, а `keccak256` не считается в обратную сторону. Хранение тройки рядом с производным id делает верификатор самодостаточным: каждый факт, нужный для повторного доказательства минта, лежит в самом блоке.

## Что проверяет верификатор

Авторизация со стороны цепи на `BridgeRefillMint` — это одна проверка: caller равен сконфигурированному оператору. Этого достаточно, чтобы случайные пользователи не могли минтить, но совершенно недостаточно, чтобы гарантировать, что указанный event реально существует. Скомпрометированный ключ оператора может вызвать `refill_mint` с выдуманной тройкой и фейковым amount; precompile послушно вставит строку и кредитует пул.

Здесь верификатор и зарабатывает свой хлеб. После того как producer выполнил кандидатный блок, но до того как верификатор его принял, каждая новая строка `bridge_mints` проходит независимый cross-chain check ([`lib/chain/verifier/cross_chain_check.ex`](https://github.com/igor53627/2d/blob/8b7caf2/lib/chain/verifier/cross_chain_check.ex)):

```elixir
def verify_block_refills(block_number) do
  block_number
  |> load_rows()
  |> Enum.reduce_while(:ok, &verify_row/2)
end

defp verify_row(row, :ok) do
  case EthereumRpc.verify_locked_event(
         row.eth_chain_id, row.eth_tx_hash,
         row.eth_log_index, Decimal.to_integer(row.amount)
       ) do
    {:ok, :verified} -> {:cont, :ok}
    {:error, reason} -> {:halt, {:error, :unbacked_refill_mint, ...}}
  end
end
```

Каждая строка порождает один Ethereum JSON-RPC roundtrip:

- `eth_getTransactionReceipt(tx_hash)` возвращает receipt; берётся лог под индексом `log_index`.
- `eth_getBlockByNumber("finalized")` возвращает номер последнего finalized блока; блок receipt-а должен быть на этом номере или раньше.

Верификатор отклоняет строку, если хоть одно из условий не выполняется:

| Reason | Что это ловит |
|---|---|
| `:not_found` | Receipt или log не существует на Ethereum. |
| `:wrong_contract` | Адрес лога не равен сконфигурированному Ethereum HTLC-контракту. |
| `:wrong_event_signature` | `topic[0]` лога не равен канонической сигнатуре event-а `Locked`. |
| `:chain_id_mismatch` | Chain id у RPC не совпадает с `eth_chain_id` из строки. |
| `:amount_mismatch` | Amount в data лога не равен заявленному `amount`. |
| `:not_finalized` | Блок существует, но ещё не дошёл до finality. |
| `:rpc_unreachable` / `:rpc_http_error` / `:malformed_response` | Defensive cases; трактуются как verification failure, не как success. |

Failure на любой строке отменяет блок как `:unbacked_refill_mint`. Верификатор откатывает свою execute-транзакцию (внешних side effect-ов нет, потому что cross-chain RPC только на чтение), отказывается коммитить и помечает producer-а как источник consensus violation.

Порядок имеет значение. Check запускается **после** `BlockExecutor.execute_transactions` (чтобы новые строки `bridge_mints` были видны внутри той же SERIALIZABLE-транзакции) и **до** `Chain.StateRoot.compute`. Producer-у доверяем на момент include, финальный авторитет — за верификатором. Скомпрометированный producer, который включил необеспеченный refill, никогда не доходит до честного пользователя; каждый честный верификатор отклоняет блок.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 300" role="img" aria-labelledby="cco-title cco-desc" style="width:100%;height:auto;max-width:720px;display:block;margin:1.5rem auto">
  <title id="cco-title">Порядок cross-chain check внутри верификатора (анимация)</title>
  <desc id="cco-desc">12-секундный цикл. Кандидатный блок едет слева направо через три этапа внутри одной SERIALIZABLE-транзакции. (1) execute_transactions применяет batch транзакций и вставляет строки bridge_mints. (2) verify_block_refills делает запросы к локальному helios-сайдкару, перепроверяя каждый указанный Ethereum-event; марширующие пунктиры между Stage 2 и helios показывают query и response. (3) StateRoot.compute сворачивает все четыре таблицы в state_root, который появляется badge-ом на блоке. (4) Блок выходит, и галочка загорается как commit.</desc>
  <style>
    .cco-frame      { fill: none; stroke: currentColor; stroke-width: 1; stroke-dasharray: 4 4; opacity: 0.3; }
    .cco-frame-lbl  { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 10px; fill: currentColor; opacity: 0.6; font-style: italic; }
    .cco-helios-box { fill: currentColor; fill-opacity: 0.05; stroke: currentColor; stroke-width: 1.5; }
    .cco-helios-lbl { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; font-weight: 700; fill: currentColor; }
    .cco-helios-sub { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 9px; fill: currentColor; opacity: 0.65; }
    .cco-helios-tag { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 9px; fill: currentColor; opacity: 0.6; }
    .cco-stage rect { fill: currentColor; fill-opacity: 0.04; stroke: currentColor; stroke-width: 1.5; }
    .cco-stage-lbl  { font-family: ui-monospace, 'SF Mono', monospace; font-size: 11px; font-weight: 700; fill: currentColor; }
    .cco-stage-sub  { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 9px; fill: currentColor; opacity: 0.7; }
    .cco-stage      { opacity: 0.4; }
    @keyframes cco-stage-on { 0%, 24% { opacity: 1; } 25%, 100% { opacity: 0.4; } }
    .cco-stage-1 { animation: cco-stage-on 12s infinite  0s; }
    .cco-stage-2 { animation: cco-stage-on 12s infinite  3s; }
    .cco-stage-3 { animation: cco-stage-on 12s infinite  6s; }
    .cco-arr      { stroke: currentColor; stroke-width: 1.5; fill: none; opacity: 0.4; }
    .cco-arr-head { fill: currentColor; opacity: 0.4; }
    .cco-helios-conn { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-dasharray: 6 4; opacity: 0; animation: cco-march 0.8s linear infinite, cco-helios-show 12s linear infinite; }
    @keyframes cco-march        { to { stroke-dashoffset: -10; } }
    @keyframes cco-helios-show  { 0%, 24% { opacity: 0; } 26%, 49% { opacity: 0.85; } 50%, 100% { opacity: 0; } }
    .cco-helios-q-lbl { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 8.5px; font-weight: 700; fill: currentColor; opacity: 0; animation: cco-helios-show 12s linear infinite; }
    .cco-block-body  { fill: currentColor; fill-opacity: 0.09; stroke: currentColor; stroke-width: 1.6; }
    .cco-block-row   { stroke: currentColor; stroke-width: 1; opacity: 0.55; }
    .cco-block-lbl   { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 9px; font-weight: 700; fill: currentColor; }
    .cco-block       { transform-box: fill-box; animation: cco-block-flow 12s infinite ease-in-out; }
    @keyframes cco-block-flow {
      0%      { transform: translate(0, 0);     opacity: 0; }
      4%      { transform: translate(0, 0);     opacity: 1; }
      12.5%   { transform: translate(105px, 0); opacity: 1; }
      25%     { transform: translate(105px, 0); opacity: 1; }
      37.5%   { transform: translate(320px, 0); opacity: 1; }
      50%     { transform: translate(320px, 0); opacity: 1; }
      62.5%   { transform: translate(535px, 0); opacity: 1; }
      75%     { transform: translate(535px, 0); opacity: 1; }
      87.5%   { transform: translate(660px, 0); opacity: 1; }
      98%     { transform: translate(660px, 0); opacity: 1; }
      100%    { transform: translate(660px, 0); opacity: 0; }
    }
    .cco-sroot       { opacity: 0; animation: cco-sroot-show 12s infinite; }
    .cco-sroot rect  { fill: #4a8e58; stroke: #336940; stroke-width: 1; }
    .cco-sroot text  { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 8.5px; font-weight: 700; fill: #fff; }
    @keyframes cco-sroot-show { 0%, 70% { opacity: 0; } 72%, 99% { opacity: 1; } 100% { opacity: 0; } }
    .cco-rows         { opacity: 0; animation: cco-rows-show 12s infinite; }
    .cco-rows rect    { fill: #c0584a; fill-opacity: 0.65; stroke: #8c3e33; stroke-width: 0.8; }
    @keyframes cco-rows-show { 0%, 8% { opacity: 0; } 12%, 65% { opacity: 1; } 70%, 100% { opacity: 0; } }
    .cco-commit       { opacity: 0; transform-box: fill-box; transform-origin: center; animation: cco-commit-show 12s infinite; }
    @keyframes cco-commit-show {
      0%, 85%   { opacity: 0; transform: scale(0.7); }
      88%       { opacity: 1; transform: scale(1.2); }
      92%, 99%  { opacity: 1; transform: scale(1); }
      100%      { opacity: 0; transform: scale(1); }
    }
    .cco-cap   { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; fill: currentColor; opacity: 0; }
    @keyframes cco-cap-on { 0%, 22% { opacity: 0.9; } 24%, 100% { opacity: 0; } }
    .cco-cap-1 { animation: cco-cap-on 12s infinite  0s; }
    .cco-cap-2 { animation: cco-cap-on 12s infinite  3s; }
    .cco-cap-3 { animation: cco-cap-on 12s infinite  6s; }
    .cco-cap-4 { animation: cco-cap-on 12s infinite  9s; }
    @media (prefers-reduced-motion: reduce) {
      .cco-stage-1, .cco-stage-2, .cco-stage-3,
      .cco-helios-conn, .cco-helios-q-lbl,
      .cco-block, .cco-sroot, .cco-rows, .cco-commit,
      .cco-cap-1, .cco-cap-2, .cco-cap-3, .cco-cap-4 { animation: none; }
      .cco-stage { opacity: 1; }
      .cco-block { transform: translate(320px, 0); opacity: 1; }
      .cco-rows  { opacity: 1; }
      .cco-cap-2 { opacity: 0.9; }
    }
  </style>

  <!-- Helios sidecar (top centre) -->
  <rect class="cco-helios-box" x="280" y="15" width="160" height="50" rx="6"/>
  <text class="cco-helios-lbl" x="360" y="36" text-anchor="middle">helios sidecar</text>
  <text class="cco-helios-sub" x="360" y="52" text-anchor="middle">eth_* через light client</text>

  <!-- Helios query / response (active during phase 2) -->
  <path class="cco-helios-conn" d="M 335 145 L 335 65"/>
  <path class="cco-helios-conn" d="M 385 65 L 385 145"/>
  <text class="cco-helios-q-lbl" x="318" y="108" text-anchor="end">↑ query</text>
  <text class="cco-helios-q-lbl" x="402" y="108" text-anchor="start">↓ response</text>

  <!-- Frame label and frame around the three stages -->
  <text class="cco-frame-lbl" x="360" y="130" text-anchor="middle">внутри одной SERIALIZABLE block-execution транзакции</text>
  <rect class="cco-frame" x="50" y="140" width="620" height="100" rx="6"/>

  <!-- Stage 1 -->
  <g class="cco-stage cco-stage-1">
    <rect x="70" y="155" width="150" height="70" rx="6"/>
    <text class="cco-stage-lbl" x="145" y="178" text-anchor="middle">execute_transactions</text>
    <text class="cco-stage-sub" x="145" y="196" text-anchor="middle">применяет tx batch,</text>
    <text class="cco-stage-sub" x="145" y="208" text-anchor="middle">пишет строки bridge_mints</text>
  </g>
  <!-- Stage 2 -->
  <g class="cco-stage cco-stage-2">
    <rect x="285" y="155" width="150" height="70" rx="6"/>
    <text class="cco-stage-lbl" x="360" y="178" text-anchor="middle">verify_block_refills</text>
    <text class="cco-stage-sub" x="360" y="196" text-anchor="middle">перепроверяет каждую</text>
    <text class="cco-stage-sub" x="360" y="208" text-anchor="middle">через helios → finalized</text>
  </g>
  <!-- Stage 3 -->
  <g class="cco-stage cco-stage-3">
    <rect x="500" y="155" width="150" height="70" rx="6"/>
    <text class="cco-stage-lbl" x="575" y="178" text-anchor="middle">StateRoot.compute</text>
    <text class="cco-stage-sub" x="575" y="196" text-anchor="middle">сворачивает четыре таблицы</text>
    <text class="cco-stage-sub" x="575" y="208" text-anchor="middle">в один keccak root</text>
  </g>

  <!-- Inter-stage arrows -->
  <line class="cco-arr" x1="225" y1="190" x2="280" y2="190"/>
  <polygon class="cco-arr-head" points="280,190 274,187 274,193"/>
  <line class="cco-arr" x1="440" y1="190" x2="495" y2="190"/>
  <polygon class="cco-arr-head" points="495,190 489,187 489,193"/>

  <!-- Block packet (animated through stages) -->
  <g class="cco-block">
    <rect class="cco-block-body" x="20" y="174" width="40" height="32" rx="4"/>
    <line class="cco-block-row" x1="26" y1="182" x2="54" y2="182"/>
    <line class="cco-block-row" x1="26" y1="188" x2="54" y2="188"/>
    <line class="cco-block-row" x1="26" y1="194" x2="54" y2="194"/>
    <line class="cco-block-row" x1="26" y1="200" x2="54" y2="200"/>
    <text class="cco-block-lbl" x="40" y="222" text-anchor="middle">candidate</text>

    <!-- bridge_mints rows badge -->
    <g class="cco-rows">
      <rect x="22" y="184" width="36" height="3" rx="1"/>
      <rect x="22" y="190" width="36" height="3" rx="1"/>
      <rect x="22" y="196" width="36" height="3" rx="1"/>
    </g>

    <!-- state_root badge -->
    <g class="cco-sroot">
      <rect x="14" y="156" width="52" height="14" rx="3"/>
      <text x="40" y="166" text-anchor="middle">state_root</text>
    </g>
  </g>

  <!-- Committed indicator -->
  <g class="cco-commit">
    <circle cx="700" cy="190" r="14" fill="#4a8e58" stroke="#336940" stroke-width="1.5"/>
    <path d="M 694 190 L 698 195 L 706 184" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- Phase captions -->
  <text class="cco-cap cco-cap-1" x="360" y="280" text-anchor="middle">1. Кандидатный блок заходит; верификатор повторяет транзакции и пишет новые строки bridge_mints.</text>
  <text class="cco-cap cco-cap-2" x="360" y="280" text-anchor="middle">2. По каждой новой строке верификатор идёт в helios: указанный Ethereum-event существует и finalized?</text>
  <text class="cco-cap cco-cap-3" x="360" y="280" text-anchor="middle">3. State root сворачивает все четыре таблицы (включая bridge_mints) в один keccak-digest.</text>
  <text class="cco-cap cco-cap-4" x="360" y="280" text-anchor="middle">4. Посчитанный root совпадает с тем, что заявил producer. Block committed.</text>
</svg>

## Helios — что на самом деле значит «Ethereum RPC»

Верификатор не доверяет Infura-endpoint-у. `eth_getTransactionReceipt` и `eth_getBlockByNumber` с удалённого RPC — это уровень RPC: ответ может быть чем угодно, что захочет вернуть оператор этого endpoint-а. Мост, который доверяет удалённому RPC для определения finality, по сути расписался в том, что отдал свою безопасность тому, кто запускает этот endpoint.

Production-верификатор вместо этого направляет JSON-RPC URL на локальный сайдкар **helios**. Helios — это light client для Ethereum: он отслеживает sync committee beacon-цепи, криптографически верифицирует header-ы и отдаёт `eth_*` JSON-RPC API, подкреплённый данными, которые проверены light-client-ом. Trust-предположение сводится к **«≥ 1/3 beacon sync committee честны»** — это тот же порог, что обеспечивает finality самого Ethereum.

В коде зависимость — это behaviour с двумя реализациями ([`lib/chain/verifier/ethereum_rpc.ex`](https://github.com/igor53627/2d/blob/8b7caf2/lib/chain/verifier/ethereum_rpc.ex)):

```elixir
defmodule Chain.Verifier.EthereumRpc do
  @callback verify_locked_event(
              chain_id :: pos_integer(),
              tx_hash :: <<_::256>>,
              log_index :: non_neg_integer(),
              expected_amount :: pos_integer()
            ) :: {:ok, :verified} | {:error, error_reason()}
end
```

`Chain.Verifier.EthereumRpc.HTTP` делает реальные JSON-RPC вызовы по `:chain, :ethereum_rpc_url`, который в production указывает на helios-процесс на том же хосте. `Chain.Verifier.EthereumRpc.Stub` возвращает настраиваемый зашитый ответ для тестов. Выбор реализации идёт через `:chain, :ethereum_rpc_module` и **fail-closed**: compile-time default-а нет. Если приложение стартует без `ETHEREUM_RPC_URL` в production или без явной конфигурации Stub-а в тестах, верификатор падает с описательным сообщением, а не молча принимает любые refill-минты.

## Сценарий bridge-in / bridge-out

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 560" role="img" aria-labelledby="bgi-title bgi-desc" style="width:100%;height:auto;max-width:720px;display:block;margin:1.5rem auto">
  <title id="bgi-title">Bridge-in: USDC на Ethereum, USD-stable на 2D, единый preimage завершает обе стороны</title>
  <desc id="bgi-desc">18-секундный цикл. (1) USDC уходит из кошелька Alice в Ethereum HTLC; vault защёлкивается под хешем H. (2) Оператор ждёт finality на Ethereum. (3) Оператор делает refill_mint, и USD-stable материализуется в пуле 2D, верификатор перепроверяет event. (4) Оператор делает lock USD-stable на 2D HTLC под тем же H. (5) Alice делает claim на 2D, раскрывая preimage P; USD-stable приходит ей в кошелёк. (6) Оператор по этому P делает claim исходных USDC на Ethereum.</desc>
  <style>
    .bgi-lane     { fill: currentColor; opacity: 0.04; stroke: currentColor; stroke-width: 1; stroke-opacity: 0.18; }
    .bgi-lane-lbl { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.18em; fill: currentColor; opacity: 0.45; }
    .bgi-conn     { fill: none; stroke: currentColor; stroke-width: 1; stroke-dasharray: 4 4; opacity: 0.28; }
    .bgi-actor-ring  { fill: none; stroke: currentColor; stroke-width: 1.5; opacity: 0.65; }
    .bgi-actor-init  { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; font-weight: 700; fill: currentColor; opacity: 0.85; }
    .bgi-actor-lbl   { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; fill: currentColor; opacity: 0.85; }
    .bgi-vault-body  { fill: currentColor; fill-opacity: 0.06; stroke: currentColor; stroke-width: 1.6; opacity: 0.85; }
    .bgi-vault-lbl   { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 10px; font-weight: 700; fill: currentColor; opacity: 0.6; }
    .bgi-op-icon  { fill: currentColor; fill-opacity: 0.07; stroke: currentColor; stroke-width: 1.5; }
    .bgi-op-halo  { fill: none; stroke: currentColor; stroke-width: 1.5; opacity: 0; transform-box: fill-box; transform-origin: center; animation: bgi-halo 3s infinite ease-out; }
    @keyframes bgi-halo {
      0%   { transform: scale(1);   opacity: 0.45; }
      100% { transform: scale(2.4); opacity: 0;    }
    }
    .bgi-badge        { opacity: 0; }
    .bgi-badge rect   { stroke-width: 1; }
    .bgi-badge text   { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 9.5px; font-weight: 700; fill: #fff; }
    .bgi-hash rect    { fill: #c0584a; stroke: #8c3e33; }
    .bgi-pre  rect    { fill: #4a8e58; stroke: #336940; }
    .bgi-hash-eth { animation: bgi-hash-eth 18s infinite; }
    .bgi-hash-2d  { animation: bgi-hash-2d  18s infinite; }
    .bgi-pre-2d   { animation: bgi-pre-2d   18s infinite; }
    .bgi-pre-op   { animation: bgi-pre-op   18s infinite; }
    .bgi-pre-eth  { animation: bgi-pre-eth  18s infinite; }
    @keyframes bgi-hash-eth { 0%, 16.5% { opacity: 0; } 17%, 83% { opacity: 1; } 84%, 100% { opacity: 0; } }
    @keyframes bgi-hash-2d  { 0%, 65%   { opacity: 0; } 66%, 73% { opacity: 1; } 74%, 100% { opacity: 0; } }
    @keyframes bgi-pre-2d   { 0%, 73%   { opacity: 0; } 75%, 99% { opacity: 1; } 100%      { opacity: 0; } }
    @keyframes bgi-pre-op   { 0%, 77%   { opacity: 0; } 79%, 89% { opacity: 1; } 91%, 100% { opacity: 0; } }
    @keyframes bgi-pre-eth  { 0%, 84%   { opacity: 0; } 86%, 99% { opacity: 1; } 100%      { opacity: 0; } }
    .bgi-tok          { transform-box: fill-box; }
    .bgi-tok text     { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 8px; font-weight: 700; fill: #fff; pointer-events: none; }
    .bgi-tok-usdc circle { fill: #4d8fc9; stroke: #2c5e88; stroke-width: 1; filter: drop-shadow(0 0 3px rgba(77,143,201,0.55)); }
    .bgi-tok-usd  circle { fill: #e8b33d; stroke: #b88718; stroke-width: 1; filter: drop-shadow(0 0 3px rgba(232,179,61,0.55)); }
    .bgi-tok-usdc { animation: bgi-usdc-flow 18s infinite ease-in-out; }
    .bgi-tok-usd  { animation: bgi-usd-flow  18s infinite ease-in-out; }
    @keyframes bgi-usdc-flow {
      0%      { transform: translate(0, 0);     opacity: 0; }
      2%      { transform: translate(0, 0);     opacity: 1; }
      16.67%  { transform: translate(270px, 0); opacity: 1; }
      83%     { transform: translate(270px, 0); opacity: 1; }
      97%     { transform: translate(540px, 0); opacity: 1; }
      100%    { transform: translate(540px, 0); opacity: 0; }
    }
    @keyframes bgi-usd-flow {
      0%, 33%   { transform: translate(0, 0);      opacity: 0; }
      36%       { transform: translate(0, 0);      opacity: 1; }
      66.67%    { transform: translate(-270px, 0); opacity: 1; }
      74%       { transform: translate(-270px, 0); opacity: 1; }
      83.33%    { transform: translate(-540px, 0); opacity: 1; }
      97%       { transform: translate(-540px, 0); opacity: 1; }
      100%      { transform: translate(-540px, 0); opacity: 0; }
    }
    .bgi-dot      { fill: currentColor; opacity: 0.22; transform-box: fill-box; transform-origin: center; }
    @keyframes bgi-dot-on { 0%, 14% { opacity: 1; transform: scale(1.35); } 16%, 100% { opacity: 0.22; transform: scale(1); } }
    .bgi-dot-1 { animation: bgi-dot-on 18s infinite  0s; }
    .bgi-dot-2 { animation: bgi-dot-on 18s infinite  3s; }
    .bgi-dot-3 { animation: bgi-dot-on 18s infinite  6s; }
    .bgi-dot-4 { animation: bgi-dot-on 18s infinite  9s; }
    .bgi-dot-5 { animation: bgi-dot-on 18s infinite 12s; }
    .bgi-dot-6 { animation: bgi-dot-on 18s infinite 15s; }
    .bgi-cap   { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11.5px; fill: currentColor; opacity: 0; }
    @keyframes bgi-cap-on { 0%, 14% { opacity: 0.9; } 16%, 100% { opacity: 0; } }
    .bgi-cap-1 { animation: bgi-cap-on 18s infinite  0s; }
    .bgi-cap-2 { animation: bgi-cap-on 18s infinite  3s; }
    .bgi-cap-3 { animation: bgi-cap-on 18s infinite  6s; }
    .bgi-cap-4 { animation: bgi-cap-on 18s infinite  9s; }
    .bgi-cap-5 { animation: bgi-cap-on 18s infinite 12s; }
    .bgi-cap-6 { animation: bgi-cap-on 18s infinite 15s; }
    @media (prefers-reduced-motion: reduce) {
      .bgi-tok-usdc, .bgi-tok-usd, .bgi-op-halo, .bgi-dot,
      .bgi-hash-eth, .bgi-hash-2d, .bgi-pre-2d, .bgi-pre-op, .bgi-pre-eth,
      .bgi-cap-1, .bgi-cap-2, .bgi-cap-3, .bgi-cap-4, .bgi-cap-5, .bgi-cap-6 { animation: none; }
      .bgi-tok-usdc { transform: translate(270px, 0); opacity: 1; }
      .bgi-tok-usd  { transform: translate(-270px, 0); opacity: 1; }
      .bgi-dot { opacity: 0.45; }
      .bgi-hash-eth, .bgi-hash-2d { opacity: 1; }
      .bgi-cap-1 { opacity: 0.9; }
    }
  </style>

  <!-- Step indicator dots -->
  <circle class="bgi-dot bgi-dot-1" cx="285" cy="20" r="5"/>
  <circle class="bgi-dot bgi-dot-2" cx="315" cy="20" r="5"/>
  <circle class="bgi-dot bgi-dot-3" cx="345" cy="20" r="5"/>
  <circle class="bgi-dot bgi-dot-4" cx="375" cy="20" r="5"/>
  <circle class="bgi-dot bgi-dot-5" cx="405" cy="20" r="5"/>
  <circle class="bgi-dot bgi-dot-6" cx="435" cy="20" r="5"/>

  <!-- Lane: ETHEREUM -->
  <rect class="bgi-lane" x="10"  y="40"  width="700" height="170" rx="10"/>
  <text class="bgi-lane-lbl" x="28" y="62">ETHEREUM</text>

  <!-- Lane: 2D CHAIN -->
  <rect class="bgi-lane" x="10"  y="340" width="700" height="170" rx="10"/>
  <text class="bgi-lane-lbl" x="28" y="362">2D&#160;CHAIN</text>

  <!-- Connection paths (ETH lane) -->
  <line class="bgi-conn" x1="115" y1="120" x2="335" y2="120"/>
  <line class="bgi-conn" x1="385" y1="120" x2="605" y2="120"/>
  <!-- Connection paths (2D lane) -->
  <line class="bgi-conn" x1="115" y1="420" x2="335" y2="420"/>
  <line class="bgi-conn" x1="385" y1="420" x2="605" y2="420"/>
  <!-- Vertical operator paths -->
  <path class="bgi-conn" d="M 360 145 Q 340 215 360 248"/>
  <path class="bgi-conn" d="M 360 295 Q 340 365 360 395"/>

  <!-- Alice @ ETH -->
  <circle class="bgi-actor-ring" cx="90" cy="120" r="22"/>
  <text class="bgi-actor-init" x="90" y="125" text-anchor="middle">A</text>
  <text class="bgi-actor-lbl"   x="90" y="170" text-anchor="middle">Alice</text>

  <!-- Ethereum HTLC vault -->
  <rect class="bgi-vault-body" x="330" y="90" width="60" height="60" rx="6"/>
  <text class="bgi-vault-lbl"  x="360" y="125" text-anchor="middle">HTLC</text>
  <text class="bgi-actor-lbl"  x="360" y="170" text-anchor="middle">Ethereum HTLC</text>

  <!-- Op USDC reserve @ ETH -->
  <circle class="bgi-actor-ring" cx="630" cy="120" r="22"/>
  <text class="bgi-actor-init" x="630" y="125" text-anchor="middle">$</text>
  <text class="bgi-actor-lbl"  x="630" y="170" text-anchor="middle">Op USDC резерв</text>

  <!-- Operator (middle) -->
  <circle class="bgi-op-halo"  cx="360" cy="270" r="22"/>
  <circle class="bgi-op-icon"  cx="360" cy="270" r="22"/>
  <text class="bgi-actor-init" x="360" y="275" text-anchor="middle">Op</text>
  <text class="bgi-actor-lbl"  x="360" y="320" text-anchor="middle">Оператор</text>

  <!-- Alice @ 2D -->
  <circle class="bgi-actor-ring" cx="90" cy="420" r="22"/>
  <text class="bgi-actor-init" x="90" y="425" text-anchor="middle">A</text>
  <text class="bgi-actor-lbl"  x="90" y="470" text-anchor="middle">Alice на 2D</text>

  <!-- 2D HTLC vault -->
  <rect class="bgi-vault-body" x="330" y="390" width="60" height="60" rx="6"/>
  <text class="bgi-vault-lbl"  x="360" y="425" text-anchor="middle">HTLC</text>
  <text class="bgi-actor-lbl"  x="360" y="470" text-anchor="middle">2D HTLC</text>

  <!-- Op USD pool / RefillMint @ 2D -->
  <circle class="bgi-actor-ring" cx="630" cy="420" r="22"/>
  <text class="bgi-actor-init" x="630" y="425" text-anchor="middle">$</text>
  <text class="bgi-actor-lbl"  x="630" y="465" text-anchor="middle">Op pool</text>
  <text class="bgi-actor-lbl"  x="630" y="479" text-anchor="middle">/ RefillMint</text>

  <!-- Hash badge on Ethereum HTLC -->
  <g class="bgi-badge bgi-hash bgi-hash-eth">
    <rect x="332" y="68" width="56" height="14" rx="3"/>
    <text x="360" y="78" text-anchor="middle">hash:H</text>
  </g>
  <!-- Hash badge on 2D HTLC -->
  <g class="bgi-badge bgi-hash bgi-hash-2d">
    <rect x="332" y="368" width="56" height="14" rx="3"/>
    <text x="360" y="378" text-anchor="middle">hash:H</text>
  </g>
  <!-- Preimage badge on 2D HTLC -->
  <g class="bgi-badge bgi-pre bgi-pre-2d">
    <rect x="328" y="368" width="64" height="14" rx="3"/>
    <text x="360" y="378" text-anchor="middle">preimage:P</text>
  </g>
  <!-- Preimage badge on Operator -->
  <g class="bgi-badge bgi-pre bgi-pre-op">
    <rect x="328" y="296" width="64" height="14" rx="3"/>
    <text x="360" y="306" text-anchor="middle">preimage:P</text>
  </g>
  <!-- Preimage badge on Ethereum HTLC -->
  <g class="bgi-badge bgi-pre bgi-pre-eth">
    <rect x="328" y="68" width="64" height="14" rx="3"/>
    <text x="360" y="78" text-anchor="middle">preimage:P</text>
  </g>

  <!-- USDC token (Alice@ETH → Ethereum HTLC → Op USDC резерв) -->
  <g class="bgi-tok bgi-tok-usdc">
    <circle cx="90" cy="120" r="14"/>
    <text x="90" y="123" text-anchor="middle">USDC</text>
  </g>

  <!-- USD-stable token (Op pool 2D → 2D HTLC → Alice на 2D) -->
  <g class="bgi-tok bgi-tok-usd">
    <circle cx="630" cy="420" r="14"/>
    <text x="630" y="423" text-anchor="middle">USD</text>
  </g>

  <!-- Phase captions -->
  <text class="bgi-cap bgi-cap-1" x="360" y="540" text-anchor="middle">1. Alice делает lock USDC на Ethereum HTLC под хешем H.</text>
  <text class="bgi-cap bgi-cap-2" x="360" y="540" text-anchor="middle">2. Оператор ждёт finality на Ethereum (~12-15 мин).</text>
  <text class="bgi-cap bgi-cap-3" x="360" y="540" text-anchor="middle">3. refill_mint минтит USD-stable в пул 2D; верификатор проверяет через helios.</text>
  <text class="bgi-cap bgi-cap-4" x="360" y="540" text-anchor="middle">4. Оператор делает lock USD-stable на 2D HTLC под тем же H.</text>
  <text class="bgi-cap bgi-cap-5" x="360" y="540" text-anchor="middle">5. Alice делает claim на 2D, раскрывая preimage P.</text>
  <text class="bgi-cap bgi-cap-6" x="360" y="540" text-anchor="middle">6. Оператор по раскрытому P забирает исходные USDC на Ethereum.</text>
</svg>

Bridge-in (Ethereum → 2D):

1. **Пользователь делает lock на Ethereum.** Alice вызывает `lock(hash, amount, deadline)` на Ethereum HTLC-контракте; `amount` USDC уходят в escrow под `hash`.
2. **Оператор ждёт finality.** Оркестратор следит за event-ом `Locked`, пуллит `eth_getBlockByNumber("finalized")` и ждёт, пока номер блока с lock-ом не окажется не больше finalized. Примерно 12-15 минут на Ethereum mainnet.
3. **Оператор делает refill пула 2D.** Оператор сабмитит `refill_mint(chain_id, tx_hash, log_index, amount)` на `0x2D00…0003`. Precompile вставляет строку в `bridge_mints` и кредитует `amount` USD-stable на счёт оператора. На следующем блоке верификатор независимо перепроверяет Ethereum-event; при успехе блок коммитится, при отказе — отклоняется.
4. **Оператор делает lock на 2D.** Оператор вызывает `lock(hash, Alice, amount, deadline)` на 2D HTLC по адресу `0x2D00…0001`; те же `amount` USD-stable уходят в escrow под тем же `hash`.
5. **Alice делает claim на 2D.** Её кошелёк вызывает `claim(preimage)` на 2D HTLC. Поскольку `sha256(preimage) = hash` и deadline не прошёл, HTLC кредитует `amount` USD-stable на счёт Alice.
6. **Оператор делает claim на Ethereum.** Preimage теперь виден на цепи 2D — в calldata claim-транзакции и в логе `HTLC_Claimed`. Оператор вызывает `claim(preimage)` на Ethereum HTLC и забирает исходные USDC в пул.

Bridge-out (2D → Ethereum) симметричен: та же роль у оператора, тот же preimage-driven settlement на обеих сторонах. Накопленные оператором USDC финансируют bridge-out выплаты; если у оператора кончились USDC на Ethereum, bridge-out exit-ы становятся в очередь, пока inflow-ы не возобновятся. DoS-вектора, который превращается в drain, не существует. Exit-ы задерживаются, не теряются.

## Сводка trust-модели

| Угроза | Что происходит |
|---|---|
| Компрометация ключа оператора | Только DoS. Атакующий может отказываться залочивать парные свопы, но не может ничего слить. Полномочий `unlock()` не существует. |
| Злонамеренный оператор сабмитит фейковый `refill_mint` | Отклоняется верификатором. Cross-chain check падает с одной из ошибок `:not_found`, `:wrong_contract`, `:amount_mismatch`, `:not_finalized`. Блок дропается. |
| Скомпрометированный producer включает необеспеченный refill | Тот же путь. Верификатор независимо отклоняет блок. До честных пользователей претензия producer-а не доходит. |
| Пользователь не успел сделать claim до deadline-а | Потеря ограничена одним свопом. `refund(hash)` возвращает средства исходному отправителю после deadline-а. |
| Helios-сайдкар лжёт | Эквивалентно тому, что ≥ 2/3 beacon sync committee злонамеренны. Вся Ethereum-цепь в этот момент скомпрометирована; мост не может быть надёжнее, чем его источник истины. |
| Компрометация удалённого Ethereum RPC | Не применимо. Верификатор не ходит во внешний RPC; он ходит на локальный helios-сайдкар, который валидирует ответы по beacon-chain-подписям. |
| Дубликат event-а сабмичен дважды | Отклоняется на стороне цепи. `bridge_mints` PK на `eth_event_id` закоммичен в [state root](../state-roots/), и producer, который обошёл бы PK-проверку, всё равно был бы пойман пересчётом state root-а у верификатора. |

Мост наследует экономическую безопасность Ethereum на стороне источника и верификатор 2D на стороне цепи. Третьей trust-стороны нет: нет федерации валидаторов, нет oracle-а, нет custodian-а.

## Куда bridge встраивается в остальную цепь

Bridge собирается из трёх кусков, описанных отдельно. [Поблочная проверка верификатора](../verifier/) распространяется на `bridge_mints` через cross-chain hook, описанный выше. [Раскладка state root-а](../state-roots/) фиксирует dedup-инвариант `bridge_mints`, и злонамеренный producer не может дважды заминтить, не сломав хеш цепи. HTLC-примитив, который собственно делает settlement, работает как [precompile](../precompiles/); bridge — это конкретный протокол поверх этого примитива, а не контракт, задеплоенный в виртуальную машину.
