# shlomi-car

שלומי טיפולי רכב: שרת ה-API (Express + MongoDB) שמגיש גם את אפליקציית הלקוח הבנויה.

הריפו מכיל את תיקיית השרת בלבד. קוד המקור של הקליינט (React + Vite) נמצא מחוץ לריפו,
והבנייה שלו מועתקת לכאן לתיקייה `public/` (מוגשת עם fallback ל-SPA מתוך `src/app.js`).

## הרצה מקומית

```bash
npm install
cp .env.example .env   # ולמלא DATABASE, DATABASE_PASSWORD, JWT_SECRET
npm run seed:user      # משתמש ראשון (פעם אחת)
npm run dev            # http://localhost:5000
```

## עדכון הקליינט

בתיקיית הקליינט:

```bash
npm run deploy         # vite build + העתקה של dist אל Server/public
```

ואז בתיקייה הזו:

```bash
git add public && git commit -m "client build" && git push
```

## פריסה ב-Render

Web Service מתוך הריפו הזה. Build: `npm install`. Start: `npm start`.
משתני סביבה: `DATABASE`, `DATABASE_PASSWORD`, `JWT_SECRET`, `JWT_EXPIRES_IN`, ואופציונלי `PUBLIC_URL`
(כתובת האפליקציה, לתצוגה מקדימה בוואטסאפ) ו-`CLIENT_ORIGIN`. `PORT` מגיע מ-Render.

## סקריפטים נוספים

| פקודה | מה עושה |
| --- | --- |
| `npm run smoke` | בדיקות API מול שרת רץ (ברירת מחדל `http://localhost:5055/api`) |
| `npm run seed:templates` / `seed:bundles` | קטלוג משימות וחבילות התחלתיים |
| `npm run recompute` | חישוב מחדש של נתוני הרכבים |
| `npm run clear:data` | מחיקת לקוחות, רכבים וטיפולים (זהירות: מסד אמיתי) |
