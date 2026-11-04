import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
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

export const db = getFirestore(app);
export const auth = getAuth(app);