# 실행 전용 최소 이미지. Postgres는 외부(DATABASE_URL)를 쓰고 이미지에 포함하지 않는다.
# esbuild는 서버 시작 시 웹 번들을 만들므로 devDependencies 포함 설치가 필요하다.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.ts"]
