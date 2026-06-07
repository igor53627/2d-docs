---
title: Мониторинг моста и auto-halt
description: Как 2D отдаёт safety-state моста через Prometheus и какие шесть слоев observability оператор скрейпит, чтобы ловить отказ canary, отклонения верифайера, потерю liveness watchdog'а и остановки bridge-in automation.
---

Bridge — самая лакомая точка атаки в любой кросс-чейн системе. Мост 2D защищается тремя in-process safety-слоями — verifier, canary, watchdog — и отдаёт их состояние через единственную точку Prometheus, чтобы оператор мог развернуть автоматические halt'ы через Alertmanager.

В статье — что отдаёт мост, как оператор это скрейпит, и какие safety-свойства подкреплены этими метриками.

## Эндпоинт scrape

```http
GET /admin/metrics
```

Plain-text exposition-format Prometheus (`text/plain; version=0.0.4`). Смонтирован под admin-префиксом, доступным только из внутренней сети — деплой ставит этот префикс за load-balancer ACL, k8s NetworkPolicy или VPC security group. Prometheus скрейпит из той же приватной сети.

Эндпоинт читает только из in-process памяти — один `:persistent_term.get/2` на scrape. Никаких запросов в БД, никаких GenServer.call в другие процессы. Scrape завершается за микросекунды и не может быть заблокирован зависшим компонентом моста — это инвариант, который позволяет ему безопасно докладывать о частично-сломанной ноде.

## Шесть слоев observability

### Слой 1 — счётчик refill-mint

Каждое успешное исполнение bridge_lock инкрементит `bridge_refill_mints_total`. Это базовый сигнал потока: сколько bridge mint'ов нода обработала с момента boot'а.

```text
bridge_refill_mints_total 12734
```

Плоский counter при ожидаемой активности пользователей — основной сигнал того, что мост halted, нода в partition или прекомпайл сломан.

### Слой 2 — счётчик отклонений верифайера

Каждый блок, в котором кросс-чейн-верифайер отверг bridge_lock, инкрементит `bridge_unbacked_bridge_mints_total{reason="…"}`. Лейбл `reason` несёт конкретный atom из bounded-перечисления: source event не найден, amount mismatch, не-финализованный event, неправильный контракт, неправильная сигнатура event'а, mismatch chain-ID, отказ HTLC-binding'а, отказ receiver-binding'а, refunded source-chain lock, отказ claimer-allowlist'а плюс небольшой набор RPC-side transport-ошибок.

Любое ненулевое приращение — безусловно критическое. Если верифайер отказывает в mint'е продюсера, это значит, что продюсер включил bridge-транзакцию, которую честный верифайер не может подтвердить через source chain. Рекомендованный response — halt и расследование per-source attribution до un-halt'а.

### Слой 3 — свежесть canary

Canary — периодически запускаемый self-test, который перепроверяет известный-валидный bridge_lock event через live Ethereum RPC. Если верификация падает, canary автоматически halt'ит мост.

Метрика свежести показывает, сколько прошло с последней успешной верификации canary:

```text
bridge_canary_last_success_seconds 47.3
```

Когда canary ни разу не публиковал heartbeat — потому что ещё не загрузился или supervisor его не запустил — gauge читается как большое конечное sentinel-значение (≈31 год). Это сознательный дизайн: emit unset-метрики или "missing" series позволил бы алертам на `metric > threshold` молча не сработать, когда canary полностью отсутствует. Конечный sentinel всегда присутствует в scrape body и всегда превышает любой реалистичный threshold оператора.

### Слой 4 — liveness watchdog'а

Watchdog работает в отдельном supervisor tree от остального моста. Его единственная задача — подтвердить, что canary жив. Если canary перестаёт публиковать heartbeat, watchdog halt'ит мост после конфигурируемого числа missed heartbeats.

Четыре gauge'а watchdog'а отдают это состояние:

```text
bridge_watchdog_consecutive_failures 0
bridge_watchdog_tripped 0
bridge_watchdog_last_canary_heartbeat_seconds 47.3
bridge_watchdog_last_tick_seconds 12.1
```

Два timestamp-поля специально различаются. `bridge_watchdog_last_tick_seconds` доказывает, что сам процесс watchdog жив. `bridge_watchdog_last_canary_heartbeat_seconds` доказывает, что canary жив И достигает verification path. Слепить их в один timestamp означало бы дать свежему watchdog tick'у замаскировать мёртвый canary — оператор, глядя на одну метку времени, увидел бы "мост мониторится", не заметив, что verification path выключен. Два различных поля заставляют дашборд оператора рендерить оба сигнала.

Тот же sentinel-pattern: never-ticked watchdog или never-published canary читаются как ≈31-летняя устаревшая метка, никаких missing-data.

### Слой 5 — circuit state

Gauge `bridge_circuit_state{tier}` отдаёт текущее halt-состояние как one-hot series — ровно один из `tier="none"`, `"yellow"`, `"red"`, `"black"` несёт `1`, остальные несут `0`:

```text
bridge_circuit_state{tier="none"} 0
bridge_circuit_state{tier="yellow"} 1
bridge_circuit_state{tier="red"} 0
bridge_circuit_state{tier="black"} 0
```

Такая форма делает Alertmanager-правило `bridge_circuit_state{tier!="none"} == 1` однозначным предикатом "мост не зелёный".

### Слой 6 — IntentWatcher (автоматизация bridge-in)

При включённых автоматических ETH claim'ах дополнительные gauge'и и counter'ы показывают, движется ли курсор Ethereum-событий, есть ли plan mismatch (возможный front-run) и падают ли автоматические claim'ы. Имена серий: префиксы `bridge_intent_watcher_*` и `bridge_intent_eth_claim_*`. Пороги, имена алертов и чеклисты расследования — per-deployment; они в operator-internal runbook, поставляемом с бинарником моста (здесь не дублируются, чтобы публичная копия не устаревала).

### Бонус — объём за 24 часа

Два gauge'а агрегируют bridge-throughput за последние 24 часа: `bridge_inflow_24h_usdc` (сумма bridge mint amount'ов) и `bridge_outflow_24h_usdc` (сумма успешно-claimed bridge HTLC swap'ов). Агрегация запускается каждые 30 секунд против on-chain state-таблиц; observational-метрика, не consensus-critical.

Эти gauge'а поддерживают volume-anomaly алерты. По дефолту — absolute threshold, тюнящийся per-deployment; операторы с достаточным историческим baseline могут заменить на σ-based recording rule.

## Self-observation

Две дополнительные метрики отдают здоровье самого коллектора:

- `bridge_metrics_collector_last_success_unix_seconds` — Unix epoch timestamp последнего опроса, где успешно завершились все коллекторы. Соответствующий PromQL-алерт — `time() - metric > threshold`; оператор устанавливает threshold примерно в 4× от своего интервала опроса.
- `bridge_metrics_collector_failures_total{collector}` — counter на каждый падающий sub-collector. Поверхностно показывает, какой конкретно коллектор сломан (database SUM, circuit-state read, canary read, watchdog read).

Без этих сигналов зависший поллер молча отдавал бы замороженные `last_value`-сэмплы бесконечно — per-collector failures counter ловит изолированные отказы, а success-timestamp ловит полное молчание поллера.

## Интеграция auto-halt

Alertmanager-правила срабатывают на пересечении threshold каждой метрикой и POST'ят в halt-endpoint моста с HMAC-подписью оператора. Прекомпайл моста проверяет HMAC, пишет новый tier circuit-state и либо блокирует новые bridge_lock'и (tier yellow), либо отвергает все взаимодействия с мостом (tier red и black).

Каждый halt пишет audit-log row, идентифицирующий source: webhook-driven halt несёт `set_by="alertmanager"` и `reason="alert:<RuleName>"`, отдельно от halt'а, инициированного вручную. Audit-log консультируется в процессе un-halt'а; множественные halt-source'ы примиряются до снятия tier.

## Trust-модель

Metrics-эндпоинт не аутентифицирован на уровне приложения. Operator runbook ставит `/admin/*` URL-префикс за network ACL — load-balancer rule, NetworkPolicy или VPC security group. Prometheus скрейпит из той же приватной сети.

Этот trade-off отдаёт эндпоинт, дешёвый на дефолтной 15-секундной cadence Prometheus, ценой требования внешней network-layer защиты. Атакующий, дотянувшийся до эндпоинта через server-side request forgery из другого места приложения, или через internal-network pivot, может прочитать 24-часовые inflow/outflow gauge'а — достаточно информации, чтобы откалибровать malicious-транзакцию ровно под daily cap. Операторам, обеспокоенным этой exposure, стоит запускать metrics-scrape из отдельного network namespace и аудитить outbound HTTP surface приложения на SSRF-паттерны.

## Что метрики НЕ отдают

By design, scrape body содержит только агрегаты. Индивидуальные event identifier'ы bridge_lock'ов, HTLC swap hash'и, claimer-адреса, transaction hash'и и любые другие per-transaction данные НЕ попадают в scrape. Audit log моста живёт в БД (читается отдельно operator tooling'ом по другому access path) и никогда не пересекается в Prometheus-surface.

Counter отклонений верифайера несёт лейбл `reason` из bounded vocabulary; никакая метадата отвергнутого event'а не достигает метрики.

## Рекомендованная конфигурация scrape

```yaml
- job_name: bridge_node
  scrape_interval: 15s
  scrape_timeout: 10s
  metrics_path: /admin/metrics
  static_configs:
    - targets: ["bridge.internal:4000"]
```

15-секундная cadence совпадает с типичными дефолтами Prometheus; 30-секундный интервал поллера внутри моста означает примерно один свежий сэмпл на два scrape'а. Уменьшение scrape interval ниже 15s не даст более свежих данных — только больше сэмплов того же значения.

Для Alertmanager-проводки receiver таргетит halt-endpoint ноды моста с per-deployment HMAC. Шаблон receiver'а, рекомендованные threshold-значения и per-alert response runbook живут в operator-internal документации, которая ships с binary'ом моста.
