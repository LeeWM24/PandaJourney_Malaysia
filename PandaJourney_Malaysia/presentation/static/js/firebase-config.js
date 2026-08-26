import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  getStorage
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-storage.js";


const firebaseConfig = {
  apiKey: "AIzaSyAX3NQdMKHFGwoySHcNAYW8dHFSnZBo_MI",
  authDomain: "pandajourney-ef50a.firebaseapp.com",
  projectId: "pandajourney-ef50a",
  storageBucket: "pandajourney-ef50a.firebasestorage.app",
  messagingSenderId: "725150303645",
  appId: "1:725150303645:web:5a0254ed334923d607db74",
  measurementId: "G-5XDDN834ZQ"
};


const app =
  initializeApp(firebaseConfig);

const auth =
  getAuth(app);

const db =
  getFirestore(app);

const storage =
  getStorage(app);


const provider =
  new GoogleAuthProvider();


provider.setCustomParameters({
  prompt: "select_account"
});


export {
  app,
  auth,
  db,
  storage,
  provider
};