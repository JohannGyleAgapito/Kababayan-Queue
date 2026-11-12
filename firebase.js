import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD347OvDy9piqEkVlCu_pYoc-jb7KbTpx0",
  authDomain: "lfg-kababayan-queue.firebaseapp.com",
  projectId: "lfg-kababayan-queue",
  storageBucket: "lfg-kababayan-queue.firebasestorage.app",
  messagingSenderId: "669506977376",
  appId: "1:669506977376:web:e462c3efa3c1412b6b0d05"
};

const app = initializeApp(firebaseConfig);

// auto-detect long-polling: survives blockers/QUIC problems that break the streaming connection
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
export const auth = getAuth(app);
