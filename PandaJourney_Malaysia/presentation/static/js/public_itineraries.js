import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { collection, doc, getDocs, getDoc, setDoc, updateDoc, addDoc, deleteDoc, serverTimestamp, increment, query, where } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

let currentUser = null;
onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  if (user) {
    await testLoadItineraries();
  }
});

// Increment Selected Itinerary View Count in Firestore
async function addView(itineraryId) {
  const itineraryRef = doc(db, "Itinerary", itineraryId);

  await updateDoc(itineraryRef, {
    views: increment(1)
  });
}

// Retrieve Itinerary Owner Name from User Collection
async function getAuthorName(userId) {
  const userRef = doc(db, "users", userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    return userSnap.data().displayName || "Unknown User";
  }

  return "Unknown User";
}

// Load All Stops and Prepare Information for Display at Selected Itinerary
async function getItineraryStops(itineraryId) {
  const stopsQuery = query(
    collection(db, "itinerary_stops"),
    where("itinerary_id", "==", itineraryId)
  );

  const snapshot = await getDocs(stopsQuery);

  const stops = snapshot.docs.map((doc) => {
    const data = doc.data();

    return {
      id: doc.id,
      ...data,
      time: data.arrival_time ?? "",
      place: data.stop_name ?? "Unknown Stop",
      note: data.category ?? ""
    };
  });

  // Arrange Itinerary Stops According to Arrival Time.
  stops.sort((a, b) => {
    return convertTimeToMinutes(a.time) - convertTimeToMinutes(b.time);
  });

  return stops;
}

// Convert 12-hour time into minutes (Stops can Sort Chronologically)
function convertTimeToMinutes(time) {
  if (!time) return 9999;

  const [timePart, period] = time.trim().split(" ");
  let [hours, minutes] = timePart.split(":").map(Number);

  if (period === "PM" && hours !== 12) {
    hours += 12;
  }

  if (period === "AM" && hours === 12) {
    hours = 0;
  }

  return hours * 60 + minutes;
}

// Toggle Current User Like Status (Prevent Same User Can Like > 1 time)
async function likeItinerary(itineraryId) {
  if (!currentUser) {
    throw new Error("Please login before liking.");
  }

  const likeId = `${itineraryId}_${currentUser.uid}`;
  const likeRef = doc(db, "itinerary_likes", likeId);
  const itineraryRef = doc(db, "Itinerary", itineraryId);

  const likeSnap = await getDoc(likeRef);

  // Remove + Decrease the Count (if Like Already Existed)
  if (likeSnap.exists()) {

    await deleteDoc(likeRef);

    await updateDoc(itineraryRef, {
      likes: increment(-1)
    });

    return false;

  } else {

    // Create a New Like Record for Current User
    await setDoc(likeRef, {
      itinerary_id: itineraryId,
      user_id: currentUser.uid,
      created_at: serverTimestamp()
    });

    await updateDoc(itineraryRef, {
      likes: increment(1)
    });

    return true;
  }
}

// Retrieve All Public Itinerary IDs Currently Liked by Logged-in User
async function getLikedPublicItineraryIds(userId) {
  if (!userId) {
    return new Set();
  }

  const likedQuery = query(
    collection(db, "itinerary_likes"),
    where("user_id", "==", userId)
  );

  const snapshot = await getDocs(likedQuery);

  return new Set(
    snapshot.docs.map((doc) => doc.data().itinerary_id)
  );
}

// Retrieve All Public Itinerary IDs Currently Saved by Logged-in User
async function getSavedPublicItineraryIds(userId) {
  if (!userId) {
    return new Set();
  }

  const savedQuery = query(
    collection(db, "Itinerary"),
    where("user_id", "==", userId)
  );

  const snapshot = await getDocs(savedQuery);

  const savedSourceIds = snapshot.docs
    .map((doc) => doc.data().source_itinerary_id)
    .filter((id) => id);

  return new Set(savedSourceIds);
}

// Save Public Itinerary as Independent Draft Itinerary
async function savePublicItineraryCopy(item) {
  if (!currentUser) {
    throw new Error("Please login before saving.");
  }

  const savedRef = doc(collection(db, "Itinerary"));
  const newItineraryId = savedRef.id;

  // Create New Saved Itinerary Owned by Current User
  await setDoc(savedRef, {
    ...item,
    itinerary_id: newItineraryId,
    user_id: currentUser.uid,
    status: "Draft",
    source_itinerary_id: item.id,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    published_at: null
  });

  // Copy Each Itinerary Stop into New Stop Document Belonging to Newly Saved Itinerary
  for (const stop of item.stopList) {
    const stopRef = doc(collection(db, "itinerary_stops"));

    await setDoc(stopRef, {
      ...stop,
      itinerary_id: newItineraryId,
      stop_id: stopRef.id,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp()
    });
  }

  // Increase Original Public Itinerary Save Count
  const originalRef = doc(db, "Itinerary", item.id);

  await updateDoc(originalRef, {
    saves: increment(1)
  });

  return newItineraryId;
}

// Expose Firestore Functions for HTML
window.addPublicItineraryView = addView;
window.likePublicItinerary = likeItinerary;
window.savePublicItineraryCopy = savePublicItineraryCopy;

// Load All "Currently Published" Itineraries 
async function testLoadItineraries() {
  const itineraryQuery = query(
    collection(db, "Itinerary"),
    where("status", "==", "Published")
  );

  const snapshot = await getDocs(itineraryQuery);

  // Retrieve User-specific Save + Like Status
  const savedIds = await getSavedPublicItineraryIds(currentUser?.uid);
  const likedIds = await getLikedPublicItineraryIds(currentUser?.uid);

  console.log("Published itinerary count:", snapshot.size);
  const itineraries = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const data = doc.data();

      // Retrieve Supporting Information for Each Itinerary
      const authorName = await getAuthorName(data.user_id);
      const stopList = await getItineraryStops(doc.id);

      return {
        id: doc.id,
        ...data,
        views: data.views ?? 0,
        likes: data.likes ?? 0,
        saves: data.saves ?? 0,
        isSaved: savedIds.has(doc.id),
        isLiked: likedIds.has(doc.id),
        description: data.description ?? "",
        author: authorName,
        duration: `${Math.floor((data.total_duration_minutes ?? 0) / 60)} hr ${(data.total_duration_minutes ?? 0) % 60} min`,
        stops: data.stop_count ?? 0,
        stopList: stopList,
        image: "/static/images/logo.png"
      };
    })
  );

  // Make Firestore Itinerary Data Available to the HTML page + Notify Loading is Complete
  window.publicItineraries = itineraries;
  window.dispatchEvent(new Event("publicItinerariesLoaded"));

  console.log("First itinerary title:", itineraries[0]?.title);
}
