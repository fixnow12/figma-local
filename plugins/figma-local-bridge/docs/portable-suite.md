# Интеграция каталога и гайдов

Кандидат `0.3.0+codex.20261014-portable-suite` сохраняет runtime package `0.3.0` и прежнее дерево зависимостей. Это версия исходников для обновления кэша Codex; сама версия не подтверждает установленный или живой runtime.

## Контракт поставки

MCP публикует 33 typed-инструмента. Каталог включает `read_catalog_inventory`, `scan_catalog_page`, `read_catalog_example`, а точные чтения — `read_node_scope`, `read_component_metadata`, `read_text_style`. Приватные source-specific prewarm/diagnostic-example маршруты и их модули в поставку не входят. Диагностика ошибок обычных чтений сохранена.

Bounded catalog traversal загружает страницу один раз для живого snapshot, сохраняет frontier и проверяет scope до resume. Document changes инвалидируют snapshot, кроме доказанно независимых локальных изменений другой страницы. Непрерывные события не дают создать snapshot до ограниченного quiet interval. Ошибка современных `componentPropertyDefinitions` не заменяется deprecated getter; SLOT сохраняется в metadata, но не становится осью вариантов.

`read_node_scope` не читает descendants и не является полным catalog evidence. `read_component_metadata` читает один узел и сообщает unavailable отдельно. `read_text_style` доказывает точные TEXT references и прямые binding identities/collection modes; не доказывает вычисленные значения переменных или pixel fidelity. `export_assets` с `format:png` требует fileKey/pageId/scale:1 и возвращает native PNG либо ошибку без уменьшения/обрезки.

## Совместимость гайдов

Сохранены строгий import через `librarySetKey` с точным child/variant, прозрачный SECTION wrapper и его штатный resize, vectorNetwork, layoutGrids/gridStyleId, layoutGrow/layoutAlign, sizing modes, resolvedVariableModes и `page-transfer-v1`. Pending native fonts сохраняются между командами; timeout не разрешает второй dispatch. Paragraph/range записи проверяют отмену до продолжения после await.

Recovery disconnected dryRun снимает только canvas journal lock. Native import остаётся unknown и replay запрещён для того же child или set. После recovered unknown set прямой child import без librarySetKey также запрещён: его независимость от прежнего set не доказана. Явный другой librarySetKey, local sourceId без import и другой файл сохраняют доступность. После recovered unknown set assembly не может доказать членство другого child по текущему input, поэтому непустые component imports в том же файле запрещены. Verify/apply без component imports, другой файл и история подтверждённого завершения не получают этот запрет. История не редактируется и не повышается до imported/equivalent.

## Проверка и развёртывание

`npm test`, `npm run schema:check` и `node ../../scripts/validate-repo.mjs` проверяют офлайн-поведение и состав. `node scripts/verify-install.mjs` без live flags проверяет MCP запуск и tools/list по manifest. Эти проверки с уже установленными dependencies не являются fresh-machine npm install.

Для использования новых исходников нужна согласованная установка и актуальные MCP/broker/plugin. Проверяйте фактические fingerprints из `src/runtime-info.mjs`, адресный `get_status({fileKey})` и capability целевого файла. Mock PASS и совпадение source SHA не заменяют Figma READY, native/user E2E или разрешение на публикацию.
