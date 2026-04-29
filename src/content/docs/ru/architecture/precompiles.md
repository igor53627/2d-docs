---
title: Precompile-ы — расширение 2D без EVM
description: Любой сети рано или поздно нужна кастомная логика сверх обычных переводов. 2D вместо EVM берёт короткий список Elixir-модулей, каждый из которых помещается в один файл и читается от начала до конца. Этот дизайн открывает двери, куда wrapped-мост зайти безопасно не может.
---

Сеть, которая умеет только двигать деньги, мало что может. Кредитование, эскроу, свопы, авторизованные записи оракулов, атомарные on/off-ramp-ы; любому серьёзному стеку нужны on-chain-контракты сложнее «списать у A, зачислить B».

Стандартный ответ индустрии — это **EVM**: универсальный интерпретатор байт-кода, выполняющий произвольный код, который любой может задеплоить. Цена известна. Газ-метринг, язык, построенный вокруг этого газ-метринга, attack-surface самой виртуальной машины, и открытый вопрос, что происходит, когда недоверенный код делает с состоянием что-то неожиданное.

2D пошла другим путём: **компактный явный реестр precompile-ов**. Каждый «контракт» — это Elixir-модуль, который помещается в один файл и читается от начала до конца. Он реализует фиксированный behaviour и живёт по фиксированному адресу в namespace `0x2D00…`. Нет интерпретатора байт-кода, нет слоя газ-метринга, в котором можно ошибиться. Набор кода закрыт: precompile-ы выкатывает сам оператор узла, поэтому что именно выполняется, известно заранее.

В статье разбираем по порядку: как транзакция находит precompile, что `@behaviour Chain.Precompile` требует от реализации, где живёт реестр, как выглядит настоящий precompile (на скетче будущего HTLC), и почему этот скетч в итоге строго надёжнее, чем wrapped-мост.

## Как транзакция находит precompile

У каждой транзакции есть `to`-адрес. Block producer идёт по happy path по шагам. Декодирует подписанную транзакцию, проверяет nonce, затем спрашивает у реестра precompile-ов, принадлежит ли `to` зарегистрированному handler-у. Hit: диспатчим в `execute/3` handler-а. Miss: проваливаемся в нативный USDC-перевод. На второй путь приходится 99% трафика, потому что обычный перевод между аккаунтами **не** precompile, это дефолт.

Код диспатча ([`lib/chain/block_producer.ex:291-319`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/block_producer.ex#L291-L319)):

```elixir
defp execute_tx_inner(pending, tx, from, to, value, fee, block_number, tx_index) do
  case to && Chain.Precompiles.Registry.lookup(to) do
    {:ok, handler} ->
      case Crypto.decode_hex_safe(tx.input) do
        {:error, _} ->
          {:error, :invalid_calldata}

        {:ok, input} ->
          if byte_size(input) < 4 do
            {:error, :invalid_calldata}
          else
            <<selector::binary-4, args::binary>> = input
            run_precompile_execute(handler, selector, args, ...)
          end
      end

    _ ->
      # нативный USDC-перевод: списать с отправителя, зачислить получателю, взять комиссию.
      ...
  end
end
```

Две ветки, одно решение. Зарегистрирован? Вызываем handler. Не зарегистрирован? Двигаем USDC. Ничего другого как кастомное выполнение не проходит; всё кастомное идёт через precompile.

## Behaviour `Chain.Precompile`

Каждый precompile реализует три колбэка ([`lib/chain/precompiles/precompile.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/precompiles/precompile.ex)):

```elixir
defmodule Chain.Precompile do
  @callback address() :: binary()

  @callback execute(selector :: binary(), args :: binary(), context :: map()) ::
              {:ok, result :: binary(), logs :: list()} | {:revert, reason :: binary()}

  @callback read(selector :: binary(), args :: binary()) ::
              {:ok, abi_encoded :: binary()} | {:revert, reason :: binary()}
end
```

- `address/0`. Где живёт этот precompile. Захардкожен в диапазоне `0x2D00…`, чтобы весь набор легко перечислить.
- `execute/3`. Точка входа, меняющая состояние. Вызывается внутри транзакции базы блока. Возвращает result + список логов, которые попадают в tx-receipt, либо `{:revert, reason}` для чистого отката.
- `read/2`. View-вызов. Используется в `eth_call` и `triggerconstantcontract`. Состояние не меняет.

`context`-мапа, передаваемая в `execute/3`, несёт то, что в Solidity называется `msg.sender` и `msg.value`, плюс высоту блока и tx-index. Всё, что нужно handler-у, чтобы понять, от чьего имени он действует. Узость этого интерфейса сделана сознательно: `execute/3`, который умеет только `Accounts.debit/credit` и чтение `context`, ревьюить сильно проще, чем целую EVM.

## Реестр

Реестр ([`lib/chain/precompiles/registry.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/precompiles/registry.ex)) — это ETS-таблица, ключом является адрес:

```elixir
def lookup(address) when is_binary(address) do
  case :ets.lookup(@table, address) do
    [{^address, module}] -> {:ok, module}
    [] -> :not_found
  end
end

def register(address, handler_module) do
  GenServer.call(__MODULE__, {:register, address, handler_module})
end
```

Boot загружает активные precompile-ы один раз, а каждая транзакция дальше платит только за ETS-lookup. Единицы микросекунд. Добавить precompile это один вызов `register/2` плюс деплой модуля. Никакого байт-кода через mempool: операторы выкатывают precompile-ы тем же способом, каким выкатывают остальной код узла.

Namespace адреса тоже имеет значение. Все системные precompile-ы живут по `0x2D00…`; верхний байт `0x2D` (ASCII `-`, от названия проекта) это зарезервированный префикс. `eth_getCode` возвращает `0x01` для любого адреса в этом диапазоне, который резолвится, так что кошельки, которые перед вызовом проверяют через `eth_getCode`, контракт ли это, получают правильный ответ без необходимости иметь полную EVM.

## HTLC precompile

Пора от абстракций к коду. Ниже HTLC precompile по адресу `0x2D00…0001`, первый precompile с реальным состоянием на цепи ([`lib/chain/precompiles/htlc.ex`](https://github.com/igor53627/2d/blob/7338952/lib/chain/precompiles/htlc.ex)).

HTLC (hashed time-locked contract) это примитив, лежащий в основе атомарных on-chain свопов. Alice лочит средства с хэшем `H` и deadline. Любой, кто знает preimage `P` такой, что `sha256(P) = H`, может забрать средства до истечения deadline. Если никто не забрал, Alice делает refund себе. Магия в том, что две стороны на двух разных сетях могут запустить парные HTLC-ы и получить своп, который либо полностью завершается (preimage раскрывается с обеих сторон), либо полностью откатывается (обе deadline-ы истекают, обе стороны получают refund). Доверять некому: ни посреднику, ни валидаторной федерации, ни единому контракту, где лежат все заблокированные средства.

```elixir
defmodule Chain.Precompiles.HTLC do
  @moduledoc """
  Hashed time-locked contract: атомарные свопы без доверенного моста.
  """
  @behaviour Chain.Precompile

  @address <<0x2D, 0::144, 0x00, 0x01>>  # 0x2D00…0001

  # 4-байтные Keccak-256-селекторы
  @lock   <<0x38, 0x5F, 0x65, 0xC3>>  # lock(bytes32,address,uint256)
  @claim  <<0x3A, 0x17, 0x94, 0xE2>>  # claim(bytes32)
  @refund <<0x02, 0xB8, 0x1C, 0x7C>>  # refund(bytes32)

  @impl true
  def address, do: @address

  @impl true
  def execute(@lock, <<hash::binary-32, receiver::binary-20, deadline::256>>, ctx) do
    case Store.get(hash) do
      :none ->
        Store.put(hash, %{
          sender: ctx.from,
          receiver: receiver,
          amount: ctx.value,
          deadline: deadline
        })

        {:ok, <<>>, [log(:HTLC_Locked, hash, ctx.from, receiver, ctx.value, deadline)]}

      _already_locked ->
        {:revert, "hash already locked"}
    end
  end

  def execute(@claim, <<preimage::binary-32>>, ctx) do
    hash = :crypto.hash(:sha256, preimage)

    with %{receiver: r, amount: a, deadline: d} <- Store.get(hash),
         true <- ctx.block_timestamp < d,
         true <- ctx.from == r,
         :ok <- Accounts.credit(r, a),
         :ok <- Store.delete(hash) do
      {:ok, <<>>, [log(:HTLC_Claimed, hash, preimage)]}
    else
      :none -> {:revert, "no lock for hash"}
      false -> {:revert, "deadline passed or not receiver"}
    end
  end

  def execute(@refund, <<hash::binary-32>>, ctx) do
    with %{sender: s, amount: a, deadline: d} <- Store.get(hash),
         true <- ctx.block_timestamp >= d,
         true <- ctx.from == s,
         :ok <- Accounts.credit(s, a),
         :ok <- Store.delete(hash) do
      {:ok, <<>>, [log(:HTLC_Refunded, hash)]}
    else
      :none -> {:revert, "no lock for hash"}
      false -> {:revert, "deadline not reached or not sender"}
    end
  end
end
```

Около 40 строк end-to-end на полный атомарно-своповый примитив. Три селектора, одно ETS-хранилище состояния с ключом по хэшу, строгие предусловия на каждой ветке. Каждый state-transition это один обозримый `with`-chain: никакого reentrancy, никаких скрытых циклов, никаких сюрпризов с газом.

## Чем это лучше моста

Обычный способ перенести активы между сетями это **wrapped-мост**. Alice отправляет USDC в custody-контракт на сети A, федерация валидаторов наблюдает лок, и на сети B для неё минтится wrapped-представление. Знакомая, широко развёрнутая, и катастрофически уязвимая схема: **с 2020 года из cross-chain мостов украдено более $2.8B, это примерно 40% всего объёма украденного в Web3** ([Chainalysis / отраслевой обзор](https://www.certik.com/resources/blog/GuBAYoHdhrS1mK9Nyfyto-cross-chain-vulnerabilities-and-bridge-exploits-in-2022)). Один только 2026 уже зафиксировал **больше $750M потерь на мостах менее чем за четыре месяца** ([Phemex — DeFi-хаки 2026](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained)).

Громкие провалы читаются как who's-who компрометации валидационного слоя:

- **Ronin** (2022, ~$620M). Фишинг пяти из девяти валидаторных ключей; атакующий подписал два огромных вывода.
- **Wormhole** (2022, ~$320M). Некорректное использование Solana-helper-а позволило принять подделанную guardian-подпись; wETH заминтился из воздуха.
- **Nomad** (2022, ~$190M). Апгрейд случайно обошёл критическую проверку, мост превратился в free-for-all.
- **Poly Network** (2021, ~$611M). Функция `lock` cross-chain manager-а позволяла выдернуть unlock произвольной суммы.

HTLC precompile не имеет федерации валидаторов, которую можно скомпрометировать, не имеет подписи, которую можно подделать, не имеет апгрейд-пути, в котором можно ошибиться, и не собирает TVL в одном контракте, который становится очевидной мишенью. Вся его модель доверия это «ты знаешь preimage» плюс «на этой сети существует deadline».

| | Wrapped-мост (Wormhole / Ronin / Nomad / …) | HTLC precompile |
|---|---|---|
| Модель доверия | N-of-M федерация валидаторов, кастодиан, или оракул | `sha256(preimage) = hash` + on-chain deadline |
| Happy path | Кастодиан одобряет wrap/unwrap | Раскрытие preimage, деньги едут |
| Unhappy path | Компрометация валидаторов сливает весь пул | Deadline истекает, обе стороны делают refund |
| Концентрация TVL | Да. Миллиарды в одном контракте | Нет. Каждый lock независим, ограничен своей суммой |
| Риск апгрейда | Multisig может апгрейдить (ещё один вектор атаки) | Деплой handler-а это обычный operator-релиз; адрес фиксирован |
| Что лежит on-chain | Контракт, который доверяет off-chain-подписантам | Весь state-машин, каждая ветка |
| Украдено с 2020 | $2.8B+ | Худший случай это один пользователь, теряющий один lock |

Последняя строка главная. Баг в мосту по природе *системный*: одна ошибка сливает весь пул. Отказ HTLC *per-swap*: одна сторона может не успеть claim или refund, и теряет максимум то, что положила в конкретный lock. Нет threat-model-а «слить весь мост», потому что никакого моста нет.

Дизайн precompile-а также обходит одну тонкую проблему мостовых свопов. **Мост это смарт-контракт, а смарт-контракты на виртуальной машине безопасны ровно настолько, насколько безопасны их реализация и upgrade-контролы**. Precompile это Elixir-модуль, отревьюенный перед отгрузкой; его upgrade-путь это релиз узла, не multisig-транзакция; его состояние это ETS-таблица со статически известным layout-ом. Attack-surface смещается с вопроса «делает ли контракт то, что написано в whitepaper» к вопросу «соответствует ли Elixir-код спецификации», и это уже задача, которую формальные методы умеют решать в промышленном масштабе.

## Компромиссы относительно EVM

Precompile-модель не бесплатный обед. Она реально отказывается от части свойств:

- **Нет деплоя от третьих лиц.** Нельзя задеплоить новый precompile, отправив байт-код в mempool. Добавление precompile это operator-релиз, как и любая другая фича узла. Это фича, если вы хотите curated-набор кода, и баг, если вы хотите open permissionless platform.
- **Меньше выразительности.** Precompile это один Elixir-модуль с фиксированной точкой входа. Нельзя построить ad-hoc композабилити двух недоверенных контрактов, как это делается на EVM. Если двум precompile-ам нужно взаимодействовать, это взаимодействие пишет оператор в Elixir.
- **Меньше экосистема.** Весь dApp-стек в EVM-совместимых сетях построен вокруг Solidity. 2D работает иначе: интегрирующимся приложениям надо идти к ABI каждого precompile-а напрямую, готовый Solidity-тулчейн из коробки не подойдёт.

Что получаем взамен:

- **Каждый on-chain-путь кода это Elixir, который можно прочитать и проверить.** Типизирован, тестируем, запускается в REPL, ограничен размером файла модуля.
- **Нет газ-метринг-сложности.** Газ-метринг существует, чтобы останавливать недоверенный код, крутящийся бесконечно. Precompile-код доверенный, ему не нужен per-opcode-метр. Благодаря этому газ-модель всей сети может быть сильно проще: не нужно per-opcode-бухгалтерии, потому что нет adversarial-опкодов.
- **Ноль VM-attack-surface.** Нет EVM-багов, нет байт-код-эксплойтов, нет тонких уязвимостей на взаимодействии опкодов. Attack-surface это несколько precompile-модулей плюс сам BEAM. Существенное сокращение.

## Стратегия безопасности

Закрытый, проверяемый набор precompile-ов открывает двери в верификации кода, которые действительно трудно открыть, когда набор кода это «что угодно, что кто угодно задеплоит»:

- **Tier 0 (baseline, сегодня).** Dialyzer + set-theoretic types Elixir 1.20 дают precompile-модулям реальные статические гарантии. Спеки на колбэки `@behaviour`-а уже отсеивают целый класс багов на malformed input.
- **Tier 1 (когда появятся настоящие precompile-ы).** Property-based тесты через PropCheck, гоняющие `execute/3` случайными парами selector+args против module-level инвариантов («сумма балансов сохраняется», «lock существует тогда и только тогда, когда он в store»).
- **Tier 2 (конкурентность).** Concuerror перебирает все возможные порядки операций ETS между реестром, handler-ом и block producer. Находит гонки и deadlock-и, которые обычные тесты не ловят.
- **Tier 3 (протокол).** TLA+ спеки (генерируемые в запускаемый Erlang через Erla+) для precompile-ов, корректность которых это многошаговый протокол, а не одна функция. Канонический target: HTLC с инвариантом «completed XOR rolled_back, никогда частично».

Каждый ярус дороже и сильнее предыдущего. Смысл в том, чтобы он собирался постепенно, по мере того как появляются настоящие precompile-ы, а не авансом.

## Куда это ведёт

Первый precompile с реальным состоянием стоит в очереди на реализацию: тот самый HTLC, скетч которого выше. Вместе с ним будет собираться FV-стек. Dialyzer и типы в CI уже сегодня. Property-тесты на PropCheck с момента, когда handler с состоянием приземлится. TLA+ спеки для HTLC и следующих precompile-ов с протокольными инвариантами.
