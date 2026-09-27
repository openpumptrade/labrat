# Railway builds the repo root — this image runs the engine + page.
FROM node:22-alpine
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev
COPY backend/src ./src
COPY backend/public ./public
COPY backend/scripts ./scripts
EXPOSE 4000
CMD ["node", "src/index.js"]
