# Gemplex Laravel Backend Upgrade

The Laravel backend source is in `laravel-backend/`.

It includes:

- MySQL migrations for users, roles, permissions, CMS content, media uploads, OTP login, and Sanctum tokens
- RBAC middleware: `role` and `permission`
- Token login with one active token flow
- CRUD APIs for OTT titles/uploads
- CMS content APIs compatible with the current website shape
- File manager APIs for backend storage
- Seeded admin/editor/viewer roles and permissions

Run it after installing PHP 8.3+ and Composer:

```bash
cd laravel-backend
composer install
copy .env.example .env
php artisan key:generate
php artisan migrate --seed
php artisan storage:link
php artisan serve --host=127.0.0.1 --port=8000
```

Default admin:

- `admin@gemplex.local`
- `password`

Current machine note: PHP and Composer are not installed here, so the Laravel app could not be executed locally yet.
