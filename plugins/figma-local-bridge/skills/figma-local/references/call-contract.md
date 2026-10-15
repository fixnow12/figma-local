# Адресная справка Bridge

Запускай из корня установленного плагина. Команды ниже работают offline, без
конфига, секретов, MCP-подключения и холста:

```bash
node scripts/tool-help.mjs render_screen
node scripts/tool-help.mjs patch_nodes --schema
node scripts/tool-help.mjs patch_nodes --validate patch-args.json
node scripts/tool-help.mjs render_screen --validate render-args.json
node scripts/call-tool.mjs --read-response response.json
```

help возвращает короткий пример; `--schema` — текущую публичную форму одного
инструмента; `--validate` использует строгий серверный парсер. Публичная форма
render_screen плоская; после адаптации строгий парсер проверяет тип узла.
Offline не проверяет существование цели, шрифты и native-свойства. Для новой
спецификации затем нужен штатный render_screen dryRun:true. Не вызывай live
dryRun в offline-задачах. Для остальных инструментов читай их MCP inputSchema;
`call-tool.mjs list TOOL` подключается к серверу, это не offline-команда.

| Ошибка | Проверенная форма |
| --- | --- |
| parentKey объект | `"parentKey":"card"`; точный Figma ID — отдельное поле parentId там, где поддержано |
| type screen у дочернего узла | screen только у spec; контейнер в spec.nodes имеет type frame |
| background у image | image использует data/mimeType/scaleMode; фон оформляй отдельным frame, не подменяй изображение цветом |
| color рядом с key | `{"key":"title","set":{"color":"#202020"}}` внутри patches |
| fill/fills наугад | render: fill у rectangle/ellipse, background у frame, color у text; patch: background/color или типизированный fills, поля fill в set нет |
| Paint похож на CSS | `"fills":[{"type":"SOLID","color":{"r":1,"g":0,"b":0}}]`; точную форму других Paint смотри в schema |
| hug в free-layout | для frame с layout.direction:none используй числовые width/height; hug требует Auto Layout или TEXT |
| типографика на маркере | inspect detail:full → точный TEXT key/id; fontSize нельзя назначать ellipse/frame/маркеру |
| screenshotScale 0.35 | запрос принимает 0.5–4; масштаб ниже 0.5 может получиться только после автоматического cap |

## Ошибки и повтор

Сначала прочитай сохранённые response.json/result.json/transport.json. CLI
сохраняет сырой ответ и распознаёт внутреннюю ошибку верхнего уровня даже без
isError; явный `result.success:false` с error тоже выводится как ошибка.
Произвольные error глубоко в дереве не меняют статус всей операции.
При нескольких независимых JSON-блоках парсер сохраняет тексты, а не угадывает.
Отсутствие operationStatus не означает not_applied. Неизвестный результат записи
требует чтения состояния. Новый CLI не реализует автоматический replay.

После второй одинаковой ошибки — диагностика, а не третий повтор: сравни
точный tool/fileKey/args, code/path и operationStatus; укажи причину и следующий
проверяемый шаг. При неизвестном результате не меняй operationId ради обхода
журнала. Повтор не является способом извлечения скрытого error.

## Снимки: обзор и детали

Bridge ограничивает длинную сторону экспорта до 1568 px. Это локальный cap
Bridge, а не обещание лимита или поведения конкретной модели.
`scale` остаётся фактическим масштабом для совместимости;
`requestedScale`, `effectiveScale`, `maxDimension`, `capped`, `sourceSize`
объясняют экспорт. Формула: effectiveScale = min(requestedScale,
1568 / max(sourceWidth, sourceHeight)), если размеры известны.
Bounds и тени могут влиять на фактические пиксельные размеры PNG.

Например, обзор 4160×1500 при requestedScale=1 даёт effectiveScale≈0.377
и примерно 1568×566 px. Это обзор композиции; мелкий текст, перекрытие CTA
и отдельные экраны по нему не приняты. Увеличение requestedScale не отменяет cap.

Адресное чтение каждого экрана (ID и fileKey из результата/чтения):

```json
{"fileKey":"TARGET_FILE","nodeId":"1:2","detail":"full","depth":3,"screenshot":true,"screenshotScale":1}
```

Если экран тоже слишком большой, запроси отдельный блок с CTA:

```json
{"fileKey":"TARGET_FILE","nodeId":"1:3","detail":"full","depth":2,"screenshot":true,"screenshotScale":2}
```

Для проверки перекрытия выбирай родителя CTA вместе с соседями, а не только
кнопку. Указывай, какие экраны и критические блоки действительно просмотрены
на свежем PNG. Геометрия, отсутствие overflow и успешный rollback не доказывают
визуальную приёмку; при недоступном PNG visual остаётся not-tested.
