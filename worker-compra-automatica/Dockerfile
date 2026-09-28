FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

CMD ["npm", "start"]
