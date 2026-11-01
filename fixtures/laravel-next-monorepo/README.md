# Acme Portal

A Laravel API (`api/`) with a Next.js frontend (`web/`).

## Getting started

```bash
git clone https://github.com/acme/portal.git
cd portal/api
composer install
cp .env.example .env
php artisan key:generate
php artisan migrate --seed
```

Then the frontend:

```bash
cd web
npm install
npm run dev
```

## Deploying

```bash
php artisan optimize
```
