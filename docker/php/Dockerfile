FROM php:8.3-fpm-alpine

# pdo_pgsql + redis-расширение
RUN apk add --no-cache postgresql-dev \
    && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS \
    && docker-php-ext-install pdo pdo_pgsql \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && apk del .build-deps

# опкэш для скорости
RUN docker-php-ext-install opcache
COPY opcache.ini /usr/local/etc/php/conf.d/opcache.ini

WORKDIR /var/www/api
