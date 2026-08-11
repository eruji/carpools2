FROM node:22-alpine

ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG BUILD_NUM=0
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV BUILD_NUM=$BUILD_NUM

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ public/

RUN mkdir -p /data
VOLUME /data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
