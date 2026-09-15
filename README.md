# Маковы — Netlify + Supabase

Готовый проект для публикации на Netlify.

## Переменные Netlify

Добавьте в Project configuration → Environment variables:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

После изменения переменных сделайте новый deploy.

## Deploy через Git

1. Загрузите содержимое этой папки в GitHub-репозиторий.
2. Netlify → Add new project → Import an existing project.
3. Выберите репозиторий.
4. Build command можно оставить пустым.
5. Publish directory: `public` (также задано в netlify.toml).
6. Deploy.

Netlify сам установит npm-зависимости и соберёт Functions.

## Проверка

- `https://ВАШ-САЙТ.netlify.app/.netlify/functions/tree`
- Главная: `https://ВАШ-САЙТ.netlify.app/`

Если API возвращает 500, смотрите Netlify → Functions → Logs и проверьте переменные окружения.


## Авторизация

Сайт закрыт через Supabase Auth + RLS.

- Без активной сессии интерфейс показывает только форму входа.
- Netlify Functions проверяют JWT и наличие пользователя в `public.profiles`.
- RLS не отдаёт генеалогические данные анонимным запросам.
- Самостоятельная регистрация не выдаёт доступ автоматически: новый Auth-пользователь должен быть явно добавлен в `public.profiles`.
- Storage bucket `genealogy-public` также переведён в private; медиа выдаются только временными signed URL.

### Первый пользователь

Создайте пользователя в Supabase Dashboard → Authentication → Users.
После создания добавьте его UUID в `public.profiles` с ролью `admin`.
Не передавайте пароль в GitHub или конфигурационные файлы.
