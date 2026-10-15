# Результаты записи и безопасное продолжение

Контракт совместим с прежними вызовами и replace. Для новых возможностей нужен свежий адресный get_status: diagnostics.ready/current, capabilityFileKey и capabilities `mutation-receipts-v1`, `render-target-parent-v1`, для reconciliation — `mutation-reconciliation-v1`. Старый запущенный plugin не гарантирует новые receipts. Установленная копия и пользовательские процессы обновляются отдельно после review.

## Идентичность запроса

render_screen и patch_nodes принимают UUID operationId: сохраните его до записи. Broker журналирует эти мутации также без явного UUID, возвращая сгенерированный ID в результате/ошибке. DryRun не журналируется как запись. get_operation_status({fileKey,operationId}) читает журнал без очереди холста: исходные аргументы, argsHash, outcome и result/error. Plugin relay сохраняет поздний результат/ошибку после timeout MCP. Отсутствие результата не означает отсутствие изменения.

UUID канонизируется в lowercase при создании, чтении, событиях и recovery. Регистр не создаёт новую операцию. Старые uppercase-файлы читаются по каноническому ID без переименования. Конфликтующие записи одного UUID блокируют журнал с OPERATION_ID_COLLISION без автоматического выбора/перезаписи.

Один UUID обозначает один запрос: retry отклоняется до dispatch; изменённые аргументы с тем же UUID отклоняются. Новая намеренная правка получает новый UUID даже с одинаковыми аргументами. Произвольный новый UUID нельзя отличить от намеренной правки; нет глобального запрета по одинаковому содержимому.

После timeout/partial/unknown прочитайте журнал, сопоставьте fileKey/operationId/argsHash/operationInput, затем фактические узлы. Settled означает завершение выполнения, а не правильность макета. При applied и ошибке PNG запросите только снимок. Опечатку, номер или маркер исправляйте адресным patch_nodes.set, без пересборки composition.

## CLI и сохранённые ответы

Без --output CLI создаёт приватный каталог `~/.figma-local-evidence-v1/<UUID>` вне репозитория. Для изолированной среды можно явно задать FIGMA_LOCAL_EVIDENCE_DIR. Путь печатается в stderr, полный прежний JSON stdout сохраняется. Автоматически на диск пишутся только компактные request/response/result/transport receipts: UUID, fileKey, requestHash, путь args-файла, outcome/error и корневые ID. requestHash — SHA256 JSON запроса, это не argsHash журнала; для reconciliation берите argsHash из get_operation_status.

В автоматическом режиме полные spec/payload и PNG не сохраняются: тяжёлые данные не накапливаются. Compact response помечен fullPayloadStored:false; он не заменяет full-read для planner. Сами компактные receipts сохраняются без автоматической ротации.

Полный raw response/result, args и PNG сохраняются только при явном --output. Новые каталоги создаются с 700, файлы с 600; файлы открываются эксклюзивно и fsync выполняется перед закрытием. Любой вызов, включая inspect_selection, резервирует request.json до запуска MCP. Каталог с request/response/result/transport/preview уже занят: запрос отклоняется до dispatch, прежние файлы не меняются. Для чтения холста нужен отдельный новый --output. Для новой правки нужны новый UUID и каталог.

Для чтения сохранённой ошибки: `node scripts/call-tool.mjs --read-response <dir>/response.json`. Команда offline, не запускает MCP и не резервирует каталог. Если ответа нет, читайте request.json/transport.json и журнал по сохранённому UUID. Не запускайте runner снова ради head/tail или диагностики.

Существующие права и данные не меняются: нет chmod, изменения ACL или cleanup. Уже существующий неприватный/чужой каталог или symlink отклоняется; выберите новый путь, создаваемый с приватными правами. На Windows существующая проверка ACL применяется только для чтения: если наследуемые права не подходят, работа останавливается без коррекции ACL. Старые .tmp-figma и другие данные не удаляются. Explicit --output — выбранный пользователем полный пакет, без автоматического удаления/ротации.

## Unknown без terminal receipt

Один inspect_selection не снимает journal-блокировку: код Plugin API после timeout может продолжать работу. Сначала получите get_operation_status с точными fileKey/operationId/argsHash. Если relay доставил terminal receipt, используйте его и независимый full-read. Если receipt отсутствует и запись остаётся unsettled unknown, доступен `reconcile_mutation({fileKey,operationId,argsHash})` по capability mutation-reconciliation-v1.

Это отдельная команда сверки render_screen/patch_nodes без replay. Broker сериализует её в очереди файла и сам доказывает:

- Исходное живое подключение исходной текущей сборки plugin/broker.
- idle, busy:false, pendingExecutions:0, activeOperation:null до и после readback.
- Полное чтение всех страниц в пределах 100000 узлов для ID/стабильных ключей исходного запроса.

Caller не передаёт proof. В plugin очередь не освобождается после timeout до завершения codePromise, поэтому idle того же runtime доказывает окончание исполнения, а не отсутствие изменений. Другой runtime/соединение, busy, ошибочный хеш, неполный readback, импорт и прочие операции отклоняются.

При успехе сохраняются originalRecord и proof; settled:true снимает блокировку выполнения, operationStatus/state остаются unknown, replayAllowed:false. Это не applied и не проверка оформления. Затем независимо inspect_selection(detail:full) затронутых узлов, сверка состояния и planner только отсутствующего append; set текста/маркеров — адресно. Исходный UUID остаётся занятым. Поздний terminal receipt после reconciliation сохраняется отдельно как lateReceipt и ACKed без изменения исходного unknown. Повторный вызов того же settled запроса возвращает сохранённую запись без повторного чтения холста.

Если исходное подключение потеряно, этот recovery не доказывает завершение старого кода и остаётся закрытым. Восстановление relay того же plugin может доставить receipt, но один новый socket не считается доказательством. Нет универсального принудительного unlock, правки/удаления журнала вручную или разрешения слепого retry. Для навсегда потерянного receipt другого runtime нужен отдельно рассмотренный контракт с доказательством прекращения исполнения; здесь он не добавлен.

## План только отсутствующего append

`node scripts/plan-patch-recovery.mjs --operation operation.json --read full-read.json --output plan.json` работает offline. operation.json — payload get_operation_status либо его поле operation; full-read.json — полный успешный inspect_selection того же файла, охватывающий append targets и детей. Планировщик проверяет исходный argsHash, settled, полноту чтения, ID/ключи/типы/родителей. Если всё существует, возвращает next:null; иначе новый patch_nodes args с новым UUID только для отсутствующих ключей. Он может продолжить недостающего ребёнка под существующим родителем.

Это предложение без dispatch. Если состояние изменилось, повторите чтение/план. Наличие ключа не доказывает оформление: существующие узлы сохраняются, различия исправляются адресно. Set, импортированные SVG/image, неполные/несогласованные доказательства не возобновляются автоматически. Новая запись проходит штатные проверки ключей и rollback. Нет общего resume произвольных мутаций и replay unknown native imports. Внешний runner без сохранённого UUID не получает автоматическое распознавание retry.

## Существующий Master

render_screen.parentId — точный ID PAGE/FRAME/SECTION на текущей странице. Неправильный тип/другая страница отклоняются до создания. Принадлежность активной странице повторно проверяется после await загрузки шрифтов, перед завершением и перед удалением заменяемого узла. Перенос Master во время сборки приводит к отказу/rollback новых слоёв с сохранением старого результата.

Без parentId прежняя PAGE-цель. Новый root всегда FRAME, wrapper SECTION для PAGE/SECTION или FRAME для FRAME. При explicit position под FRAME Auto Layout wrapper получает layoutPositioning:ABSOLUTE, layout родителя не меняется.

Поля sectionId и placement.sectionParentId сохранены как aliases wrapper для FRAME. Проверяйте wrapperType: rootParentId равен sectionId; sectionParentId и destinationParentId — ожидаемому parentId. Независимо inspect_selection rootId и sectionId проверяет фактические parentId. Имя страницы Master не доказывает вложенность в узел Master. Замена существующего ключа из другого destination блокируется; непустой Master не удаляется.

## Долговечность и межпроцессные границы

Первое создание UUID использует canonical filename и эксклюзивное wx: два процесса с разным регистром одного UUID не могут перезаписать запись. Обновления используют уникальные временные файлы, fsync файла, atomic rename и fsync каталога на POSIX; файлы 600. На Windows заявлен file fsync, без directory fsync. CLI receipts также используют wx/file fsync и POSIX directory fsync. Тест двух настоящих процессов проверяет конфликт одного UUID, повторная загрузка журнала — сохранение записей. Это не испытание отключением питания и не гарантия сетевых файловых систем.

Штатная архитектура использует один broker на installation/state directory. Распределённая синхронизация in-memory журналов нескольких намеренно запущенных brokers не добавлена. Разные UUID не объявляются дублями. Незавершённая/повреждённая JSON после аварии блокирует автоматическое продолжение вместо молчаливого удаления. Старые записи не мигрируются/не удаляются; legacy hash с uppercase внутри operationInput может потребовать отдельной проверки и не разрешает повтор записи.

Offline/mock проверки не доказывают визуальное качество, поведение Figma в фоне, влияние фокуса или причины долгих shell-вызовов. Нужен отдельный разрешённый пользовательский запуск после review и синхронизации установки.
