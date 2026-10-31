# Результат подготовки AgentSys

Изменения выполнены поверх существующего рабочего дерева без отката пользовательских правок. Исходный аудит: [execution-audit.md](execution-audit.md). Полный контракт, примеры и границы гарантий: [durable-execution.md](durable-execution.md).

## Реализовано

- Идентификаторы run, dispatch, parent dispatch, invocation и parent invocation; привязка вызовов и сигналов к версии живого графа. Независимые Run/editor events/evaluation не смешиваются. Вложенные checked API и настоящие Worker плагинов передают причинную связь.
- Независимые JSON-области с обязательной проверкой версии, конфликтом 409, сохранением версии после удаления и очисткой только временных данных выбранного run. Используется существующий KV store; CAS атомарен в IndexedDB и на границе файловой записи сервера.
- Защита поздних state/output/API-операций после Stop, удаления узла и смены Worker. Новый Run во время Stop ожидает границу отмены. Stop распространяется на checked сетевые запросы, плагины и дочерние workflow.
- Структурированная история dispatch, вызовов, сигналов, ожиданий, ошибок, изменений состояния, API-вызовов и управления исполнением. Фильтры, курсор, retention по количеству/байтам/возрасту и отключение детализации. Тела запросов, код, токены, результаты и свободный текст ошибок не попадают в трассировку.
- Операции `pending/running/completed/failed/cancelled/interrupted`, входы/результаты/структурированные ошибки, номера попыток и история переходов. Явные политики `safe/idempotent/manual`, стабильный ключ идемпотентности, отдельные retry и пользовательское resolve. Перезапуск не повторяет действия автоматически.
- Универсальная библиотека [sdk/operations.js](../sdk/operations.js) выполняет callback только после успешного CAS-захвата попытки и возвращает сохранённый результат завершённого этапа.
- Опциональные наследуемые бюджеты времени, вызовов, dispatch, активных тел и операций. Превышение возвращает самостоятельный исход `budget_exceeded`. Watchdog работает снаружи Worker и прерывает бесконечный синхронный Script.
- Properties / Permissions для standalone Script без Developer mode, эффективные ограничения проекта/вложенных узлов, запрет самоавторизации. Workflow / Execution / Execution history показывает историю с переходом к узлу.
- Общие API, удобные методы `app.workflows`, TypeScript-декларации, автоматически обновляемый OpenAPI и документация. AI-специфические сущности в ядро не добавлялись.

## Основные API

Все пути ниже имеют префикс `/api/projects/{project_id}/`. Для GET/DELETE выбирается query `workflow_id`, для мутаций — поле тела.

| Назначение | Интерфейс |
| --- | --- |
| Запуск | `POST execution` с `node_ids`, `payload`, `wait`, `policy`, `parent_dispatch_id` |
| Статус и результат dispatch | `GET execution/dispatches/{id}` |
| Отмена | `DELETE execution` или `DELETE execution/dispatches/{id}`; прерывается общий Worker workflow |
| История | `GET execution/trace` с фильтрами и курсором |
| Политика истории | `GET/PUT execution/retention`; изменение только пользователем |
| Независимое JSON | `GET/PUT/DELETE execution/scopes/{id}`; ожидаемая `version` обязательна |
| Временные данные | `DELETE execution/scopes?run_id=...` |
| Контрольные точки | `GET/POST execution/operations`, `GET/PUT execution/operations/{id}` |
| Повтор | `POST execution/operations/{id}/retry` с текущей версией |
| Ручное решение | `POST execution/operations/{id}/resolve`; только пользователь |
| Разрешения Script | `GET/PUT node-permissions/{node_id}`; изменение только пользователем |

Пример внутри Script:

```js
const path = `projects/${context.project_id}/execution/scopes/${context.execution.run_id}`;
const before = await agentsys('GET', path);
await agentsys('PUT', path, {
  version: before.version,
  value: {result: 42},
  temporary: true,
});
```

Пример для внешнего контроллера с адаптером `request(method,path,body,query)`:

```js
const {createOperationRunner} = require('./sdk/operations');
const operations = createOperationRunner(request, {project_id, workflow_id});
const result = await operations.execute('sum', {a:20,b:22},
  async ({input}) => input.a + input.b,
  {policy:'safe',retry:true});
```

Пример целого процесса: `node examples/durable-process.cjs`. Два Script выполняются параллельно и сохраняют 20 и 22 в отдельных областях. Агрегация намеренно падает, сервер перезапускается, разрешённая попытка №2 получает 42 из сохранённых результатов. Директория данных печатается для проверки.

## Проверки

- Исходный `npm test`: **211/211**.
- Итоговый `npm test`: **233/233**, включая **22 новых Node-теста**.
- `python tests/browser_suite.py`: **17/17**, включая новый UI-сценарий.
- Дополнительный повтор `durable_execution execution_ui` проверяет grants/history и прежние Run/Pause/Resume/Stop после финальных изменений backend.
- `git diff --check` с учётом CRLF: без ошибок whitespace.

Проверены конкурирующие записи/захваты операции, tombstone после удаления, независимые параллельные результаты, on_read, live code/rewiring, Stop реального HTTP и синхронного бесконечного Script, Run одновременно со Stop, Worker recreation, отзыв прав, отказ диска, отсутствие чувствительных данных в трассе, бюджеты и длинные интервалы watchdog. Отдельный тест принудительно убивает процесс сервера, затем проверяет завершённые/прерванные этапы и отсутствие автоматического повтора внешней операции. Старые проверки не ослаблялись.

## Совместимость и ограничения

Живой граф, Script/Event, автоматический `out`, Custom Nodes, Library, актуальные permissions, shared `context.state` и последние значения портов сохранены. Обычные workflow не требуют миграции и не получают обязательных лимитов. Новые области/операции используются явно. Копии и импорт продолжают переносить обычное graph/runtime JSON; история исполнения начинается заново.

Границы гарантий:

- JavaScript-стек, таймеры и запросы после рестарта не восстанавливаются; детерминированный replay отсутствует.
- Exactly-once для внешнего сервиса не обещается. Idempotent-политика требует реальной поддержки ключа сервисом; неопределённый manual-исход требует решения человека.
- Принудительное завершение общего Worker останавливает другие dispatch в том же workflow. Parallelism считает и ожидающие тела; скрытой очереди нет. Бюджет активных checkpoint-операций считается в выбранном workflow.
- Нужен один авторитетный execution backend на workflow. Это не распределённый multi-server runtime. Пользовательский headless store должен предоставить CAS для работы нескольких backend.
- Shared state остаётся нетранзакционным. Runtime JSON, журнал и внешние эффекты не объединены одной транзакцией. Ошибки записи сообщаются вызывающему коду/через `storage_error`.
- Trace буферизуется; авария может потерять последний несохранённый диагностический пакет. Подтверждённые checkpoints сохраняются отдельно. История операций, пользовательские области и tombstones сохраняются до удаления workflow; retention их не удаляет.

Независимые контексты строятся как отдельные scope ID с CAS, дерево операций — через `parent_id`, а причинное дерево запусков — через parent dispatch/invocation. Контроллер запускает части обычным API, читает результаты/статусы, сохраняет решения и явно повторяет только разрешённые этапы.

Декомпозиция, семантическое наследование/слияние контекстов, планировщик, prompts, выбор моделей/providers, учёт токенов/стоимости и предметные правила повторов/согласований должны находиться в будущем контроллере или плагине.

## Затронутые файлы этой задачи

Прочие незакоммиченные изменения уже существовали до начала работы.

- Запуск/хранилище: `index.html`, `server.js`, `js/storage/db.js`, `js/model/executor.js`.
- Backend: `js/backend/execution-store.js`, `execution.js`, `runtime.js`, `scripts.js`, `plugin-api.js`, `plugin-runtime.js`, `plugins.js`, `routes-permissions.js`, `routes-plugins.js`, `routes-workflow.js`.
- UI: `js/inspector/inspector.js`, `js/canvas/run.js`, `js/pages/api.js`.
- SDK/пример: `sdk/operations.js`, `sdk/script.d.ts`, `sdk/plugin.d.ts`, `examples/durable-process.cjs`.
- Тесты: `tests/durable-execution.test.js`, `tests/durable-server.test.js`, `tests/browser_durable_execution.py`, `tests/browser_suite.py`.
- Документация: `README.md`; в `docs/`: `execution-audit.md`, `durable-execution.md`, `execution-report.md`, `api.md`, `code-guide.md`, `concepts.md`, `decisions.md`, `engine.md`, `limits.md`, `mvp-audit.md`, `permissions.md`, `plugins.md`, `roadmap.md`, `runtime.md`, `scripts-api.md`, `testing.md`.
