# בונה את שתי חבילות ה-workspace (שרת ולקוח) ומריץ את השרת, שמגיש את
# הלקוח הבנוי מ-web/dist בעצמו - ראו server/src/main.ts. שלב יחיד: הפשטות
# חשובה יותר מגודל האימג' בשלב הזה.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "--no-warnings=ExperimentalWarning", "server/dist/main.js"]
