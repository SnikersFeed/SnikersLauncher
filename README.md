# Simple MC Launcher

Простой Minecraft-лаунчер на Electron: никнейм, выбор сборки, кнопка «Играть».
Список версий и файлы сборок берутся из GitHub, обновления модов проверяются при запуске,
сам лаунчер тоже умеет обновляться через GitHub Releases.

## Возможности

- Оффлайн-запуск по никнейму (без Microsoft-аккаунта).
- Сборки с загрузчиками **Vanilla, Fabric, Forge, NeoForge**.
- Список сборок из `manifest.json` в GitHub-репозитории.
- Проверка и докачка изменённых файлов сборки при каждом запуске.
- Удаление устаревших файлов, которые лаунчер ставил раньше (пользовательские сохранения не трогаются).
- Прогресс установки Minecraft, загрузки модов и запуска.
- Автоопределение Java (JAVA_HOME, Program Files, `.minecraft/runtime`, `.jdks`, `PATH`).
- Проверка обновлений лаунчера через GitHub Releases и запуск установщика.
- Тёмный интерфейс, лог запуска, настройки памяти и пути к Java.

## Быстрый старт

### 1. Установить зависимости

```bash
npm install
```

### 2. Подготовить репозиторий сборок

Готовый репозиторий со сборками: <https://github.com/SnikersFeed/modpacks>.
Шаблон для своего репозитория лежит в [`repo-template/`](repo-template), подробная инструкция —
в [README шаблона](https://github.com/SnikersFeed/modpacks#readme).

Коротко:

```bash
npm install --prefix tools   # внутри repo-template
node tools/build-pack.mjs --pack packs/example-fabric --repo USER/REPO --tag pack-example-fabric-v1
```

Затем запустите workflow **Publish pack** в GitHub Actions.

> Для больших сборок (файлы больше 100 МБ) папку `files/` не коммитят: архив `pack.zip`
> собирают локально и загружают в GitHub Releases вручную. Подробности — в README шаблона.

### 3. Указать репозиторий в конфиге

Откройте `config/launcher.json`:

```json
{
  "repo": "SnikersFeed/modpacks",
  "branch": "main",
  "manifestPath": "manifest.json",
  "launcherRepo": "SnikersFeed/SnikersLauncher",
  "updateAssetPattern": "\\.exe$",
  "silentUpdate": false
}
```

- `repo` — репозиторий с `manifest.json` и сборками.
- `launcherRepo` — репозиторий, в релизах которого лежит установщик лаунчера.
  Можно указать тот же репозиторий.
- `manifestUrl` — необязательная прямая ссылка на манифест (переопределяет `repo/branch/manifestPath`).
- `updateAssetPattern` — регулярка для выбора файла установщика среди assets релиза.
- `silentUpdate` — `true`, чтобы запускать NSIS-установщик с `/S` (тихая установка).

Пока репозиторий не настроен (`OWNER/REPO`), лаунчер показывает демо-сборку Vanilla 1.20.1,
чтобы можно было проверить запуск.

### 4. Запустить

```bash
npm start
```

Для отладки с DevTools:

```bash
npm run dev
```

## Сборка установщика

```bash
npm run dist
```

Готовый файл: `dist/SimpleMCLauncher-Setup-<version>.exe`.

Перед сборкой не забудьте поменять `repo` и `launcherRepo` в `config/launcher.json` —
этот файл попадает внутрь приложения.

Иконка приложения лежит в `build/icon.png` и генерируется скриптом:

```bash
npm run icon
```

## Проверка

```bash
npm test
```

Smoke-тесты проверяют разбор манифестов, защиту от path traversal, обновление и удаление
файлов сборки, оффлайн-UUID, сравнение версий и разбор версий Java.

## Как это работает

### Манифест сборок

`manifest.json` в GitHub-репозитории:

```json
{
  "schemaVersion": 1,
  "packs": [
    {
      "id": "my-pack",
      "name": "My Pack 1.20.1",
      "description": "Описание",
      "manifest": "packs/my-pack/pack.json"
    }
  ]
}
```

`packs/<id>/pack.json` описывает Minecraft-версию, загрузчик, память, аргументы и список файлов.
Формат подробно описан в [README шаблона](https://github.com/SnikersFeed/modpacks#readme).

### Обновление файлов

При нажатии «Играть» лаунчер:

1. Читает `pack.json` (с `Cache-Control: no-cache`).
2. Сравнивает SHA1 и размер каждого файла с локальными.
3. Если что-то изменилось — скачивает `pack.zip` один раз и распаковывает только изменившиеся файлы.
4. Удаляет файлы, которые ставил сам, но которых больше нет в манифесте (при `deleteObsolete: true`).
5. Сохраняет состояние в `<папка сборки>/.launcher/state.json`.

Файлы, созданные игрой или пользователем (`saves/`, `options.txt`, скриншоты и т.п.), не удаляются.

### Установка Minecraft и загрузчиков

Используются библиотеки [`@xmcl/core`](https://www.npmjs.com/package/@xmcl/core) и
[`@xmcl/installer`](https://www.npmjs.com/package/@xmcl/installer):

- Vanilla — официальный `version_manifest` Mojang, библиотеки и assets.
- Fabric — `meta.fabricmc.net`.
- Forge — официальный установщик и его processors.
- NeoForge — `maven.neoforged.net`, а если он недоступен у провайдера — зеркала
  `maven.creeperhost.net` и `repo.papermc.io`. Установщик NeoForge в Maven Central отсутствует,
  поэтому лаунчер скачивает его сам, а не через `@xmcl/installer`.

Перед скачиванием лаунчер проверяет, какие Maven-хосты отвечают (таймаут 5 секунд),
и ставит параллельные загрузки на рабочий хост — иначе на 1–2 минуты можно залипнуть
на недоступном `maven.neoforged.net`. Список зеркал — в `src/main/maven.js`.

Общие файлы (versions/libraries/assets) лежат в одной папке и переиспользуются между сборками.

### Обновление лаунчера

При старте лаунчер запрашивает `https://api.github.com/repos/<launcherRepo>/releases/latest`.
Если `tag_name` новее текущей версии, появляется кнопка «Обновить до X.Y.Z».
По нажатию скачивается asset, подходящий под `updateAssetPattern`, и запускается установщик.

Чтобы это работало, публикуйте лаунчер так:

1. Поднимите `version` в `package.json` (например, `1.1.0`).
2. `npm run dist`.
3. Создайте GitHub Release с тегом `v1.1.0`.
4. Прикрепите `dist/SimpleMCLauncher-Setup-1.1.0.exe` к релизу.

## Где лежат данные

Всё хранится в `%APPDATA%/simple-mc-launcher/data` (Windows):

```
data/
  minecraft/          # versions, libraries, assets — общие для всех сборок
  instances/<id>/     # папка конкретной сборки: mods, config, saves
  cache/archives/     # скачанные pack.zip
```

Настройки пользователя — `%APPDATA%/simple-mc-launcher/config.json`
(ник, выбранная сборка, память, путь к Java).

## Ограничения

- Авторизация оффлайн: подходит для одиночной игры и серверов с `online-mode=false`.
  Для лицензионных серверов нужен Microsoft OAuth (не реализован).
- Java не скачивается автоматически: лаунчер ищет установленную. Если её нет — покажет
  понятную ошибку и позволит указать путь вручную.
- GitHub Releases имеет лимит 2 ГБ на файл и 1000 assets на релиз. Для очень больших сборок
  лучше несколько релизов или внешний хостинг (формат поддерживает любые прямые URL).
- Лаунчер не проверяет подпись скачанных модов — доверяйте только своему репозиторию.

## Структура проекта

```
config/launcher.json      # repo, branch, настройки обновлений
src/main/                 # Electron main: манифесты, синк, установка, запуск, апдейтер
src/preload.js            # безопасный мост IPC
src/renderer/             # интерфейс
repo-template/            # шаблон GitHub-репозитория со сборками
scripts/                  # smoke-тесты и генератор иконки
build/icon.png            # иконка приложения
electron-builder.yml      # конфигурация NSIS-установщика
```
