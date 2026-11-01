# Clean machine for end-to-end runs: PHP 8.4 with common extensions, Composer 2, Node.js 22 with Corepack,
# Go, git. No database servers: repos that need one are run without it (see VALIDATION.md).
FROM php:8.4-cli-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git unzip curl ca-certificates procps \
      libzip-dev libpng-dev libjpeg-dev libfreetype6-dev libicu-dev libpq-dev libonig-dev libxml2-dev libgmp-dev \
    && rm -rf /var/lib/apt/lists/*
RUN docker-php-ext-configure gd --with-jpeg --with-freetype \
    && docker-php-ext-install -j"$(nproc)" pdo_mysql pdo_pgsql zip gd intl bcmath pcntl exif gmp \
    && pecl install redis && docker-php-ext-enable redis
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable
COPY --from=golang:1.25-bookworm /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COMPOSER_ALLOW_SUPERUSER=1
RUN useradd -m dev
USER dev
WORKDIR /work
