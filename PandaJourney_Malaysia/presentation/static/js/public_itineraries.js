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
async function getItineraryStops(itineraryIds) {
  const ids = Array.from(new Set(
    (Array.isArray(itineraryIds) ? itineraryIds : [itineraryIds]).filter(Boolean)
  ));
  const mergedStops = new Map();

  for (const itineraryId of ids) {
    const stopsQuery = query(
      collection(db, "itinerary_stops"),
      where("itinerary_id", "==", itineraryId)
    );

    const snapshot = await getDocs(stopsQuery);

    snapshot.docs.forEach((doc) => {
      const data = doc.data();

      mergedStops.set(doc.id, {
        id: doc.id,
        ...data,
        time: data.arrival_time ?? "",
        place: data.stop_name ?? "Unknown Stop",
        note: data.category ?? ""
      });
    });
  }

  const stops = Array.from(mergedStops.values());

  stops.sort((a, b) => {
    const dayDifference = Number(a.day_number || 1) - Number(b.day_number || 1);
    if (dayDifference) return dayDifference;
    return Number(a.stop_order || 0) - Number(b.stop_order || 0);
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

  const {
    id: sourceDocumentId,
    stopList = [],
    author,
    isLiked,
    isSaved,
    duration,
    stops,
    ...sourceData
  } = item;

  // Create New Saved Itinerary Owned by Current User
  await setDoc(savedRef, {
    ...sourceData,
    itinerary_id: newItineraryId,
    user_id: currentUser.uid,
    status: "Draft",
    is_public: false,
    views: 0,
    likes: 0,
    saves: 0,
    source_itinerary_id: item.id,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    published_at: null
  });

  // Copy Each Itinerary Stop into New Stop Document Belonging to Newly Saved Itinerary
  for (const stop of item.stopList) {
    const stopRef = doc(collection(db, "itinerary_stops"));
    const {
      id,
      document_id,
      time,
      place,
      note,
      ...stopData
    } = stop;

    await setDoc(stopRef, {
      ...stopData,
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

async function unsavePublicItinerary(sourceItineraryId) {
  if (!currentUser) {
    throw new Error("Please login before unsaving.");
  }

  const savedQuery = query(
    collection(db, "Itinerary"),
    where("user_id", "==", currentUser.uid),
    where("source_itinerary_id", "==", sourceItineraryId)
  );

  const savedSnapshot = await getDocs(savedQuery);

  if (savedSnapshot.empty) {
    return false;
  }

  const savedDoc = savedSnapshot.docs[0];
  const savedData = savedDoc.data();

  const savedItineraryId =
    savedData.itinerary_id || savedDoc.id;

  const stopsQuery = query(
    collection(db, "itinerary_stops"),
    where("itinerary_id", "==", savedItineraryId)
  );

  const stopsSnapshot = await getDocs(stopsQuery);

  for (const stopDoc of stopsSnapshot.docs) {
    await deleteDoc(
      doc(db, "itinerary_stops", stopDoc.id)
    );
  }

  await deleteDoc(
    doc(db, "Itinerary", savedDoc.id)
  );

  const originalRef = doc(
  db,
  "Itinerary",
  sourceItineraryId
);

const originalSnap = await getDoc(originalRef);

if (originalSnap.exists()) {
  const currentSaves =
    originalSnap.data().saves ?? 0;

  await updateDoc(originalRef, {
    saves: Math.max(0, currentSaves - 1)
  });
}

  return true;
}

// Expose Firestore Functions for HTML
window.addPublicItineraryView = addView;
window.likePublicItinerary = likeItinerary;
window.savePublicItineraryCopy = savePublicItineraryCopy;
window.unsavePublicItinerary = unsavePublicItinerary;

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
      const stopList = await getItineraryStops([doc.id, data.itinerary_id]);

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
        stops: stopList.length || data.stop_count || 0,
        stopList: stopList
      };
    })
  );

  // Make Firestore Itinerary Data Available to the HTML page + Notify Loading is Complete
  window.publicItineraries = itineraries;
  window.dispatchEvent(new Event("publicItinerariesLoaded"));

  console.log("First itinerary title:", itineraries[0]?.title);
}

// Load Community Photo for Each Itinerary
async function loadCommunityPhoto(item) {
  const carousel = document.querySelector(
    `[data-carousel="${item.id}"]`
  );

  if (!carousel) return;

  const candidateStops = (item.stopList || [])
    .filter((stop) => {
      const placeName = String(
        stop.stop_name ||
        stop.place ||
        ""
      ).trim();

      if (!placeName) return false;

      const genericLocationNames = [
        "kuala lumpur, malaysia",
        "federal territory of kuala lumpur, malaysia",
        "malaysia"
      ];

      if (genericLocationNames.includes(placeName.toLowerCase())) {
        return false;
      }

      return true;
    });

  if (!candidateStops.length) {
    carousel.innerHTML = `
      <div class="community-photo-placeholder">
        No photo available
      </div>
    `;
    return;
  }

  const photoCache = new Array(candidateStops.length).fill(null);

  let currentIndex = 0;

  // Load Photo for a Specific Stop Index
  async function loadPhoto(index) {
    if (photoCache[index] !== null) {
      return photoCache[index];
    }

    const stop = candidateStops[index];

    const placeName = String(
      stop.stop_name ||
      stop.place ||
      ""
    ).trim();

    try {
      const response = await fetch(
        `/api/public-place-photo?name=${encodeURIComponent(placeName)}`
      );

      const data = await response.json();

      photoCache[index] = {
        imageUrl: data.image_url || "",
        placeName: placeName
      };

      return photoCache[index];

    } catch (error) {
      console.error("Community photo failed:", error);

      photoCache[index] = {
        imageUrl: "",
        placeName: placeName
      };

      return photoCache[index];
    }
  }

  // Render the Carousel Photo for the Current Index
  async function renderCarouselPhoto() {
    carousel.innerHTML = `
      <div class="community-photo-placeholder">
        Loading photo...
      </div>
    `;

    const photo = await loadPhoto(currentIndex);

    carousel.innerHTML = `
      ${
        photo.imageUrl
          ? `
            <img
              class="community-photo"
              src="${photo.imageUrl}"
              alt="${photo.placeName}"
              loading="lazy"
            >
          `
          : `
            <div class="community-photo-placeholder">
              No photo available
            </div>
          `
      }

      <div class="community-photo-label">
        ${photo.placeName}
      </div>

      <div class="community-photo-count">
        ${currentIndex + 1} / ${candidateStops.length}
      </div>

      ${
        candidateStops.length > 1
          ? `
            <button
              class="community-carousel-btn community-carousel-prev"
              type="button"
              aria-label="Previous photo"
            >
              ‹
            </button>

            <button
              class="community-carousel-btn community-carousel-next"
              type="button"
              aria-label="Next photo"
            >
              ›
            </button>
          `
          : ""
      }
    `;

    if (candidateStops.length > 1) {
      carousel
        .querySelector(".community-carousel-prev")
        .addEventListener("click", async (event) => {
          event.stopPropagation();

          currentIndex =
            (currentIndex - 1 + candidateStops.length) %
            candidateStops.length;

          await renderCarouselPhoto();
        });

      carousel
        .querySelector(".community-carousel-next")
        .addEventListener("click", async (event) => {
          event.stopPropagation();

          currentIndex =
            (currentIndex + 1) %
            candidateStops.length;

          await renderCarouselPhoto();
        });
    }
  }

  await renderCarouselPhoto();
}

async function loadDetailPhotoCarousel(item) {
  const carousel = document.querySelector(
    `[data-detail-carousel="${item.id}"]`
  );

  if (!carousel) return;

  const candidateStops = (item.stopList || [])
    .filter((stop) => {
      const placeName = String(
        stop.stop_name ||
        stop.place ||
        ""
      ).trim();

      if (!placeName) return false;

      const genericLocationNames = [
        "kuala lumpur, malaysia",
        "federal territory of kuala lumpur, malaysia",
        "malaysia"
      ];

      if (genericLocationNames.includes(placeName.toLowerCase())) {
        return false;
      }

      return true;
    });

  if (!candidateStops.length) {
    carousel.innerHTML = `
      <div class="community-photo-placeholder">
        No photo available
      </div>
    `;
    return;
  }

  const photoCache =
    new Array(candidateStops.length).fill(null);

  let currentIndex = 0;

  async function loadPhoto(index) {
    if (photoCache[index] !== null) {
      return photoCache[index];
    }

    const stop = candidateStops[index];

    const placeName = String(
      stop.stop_name ||
      stop.place ||
      ""
    ).trim();

    try {
      const response = await fetch(
        `/api/public-place-photo?name=${encodeURIComponent(placeName)}`
      );

      const data = await response.json();

      photoCache[index] = {
        imageUrl: data.image_url || "",
        placeName: placeName
      };

      return photoCache[index];

    } catch (error) {
      console.error(
        "Detail photo failed:",
        error
      );

      photoCache[index] = {
        imageUrl: "",
        placeName: placeName
      };

      return photoCache[index];
    }
  }

  async function renderDetailPhoto() {
    carousel.innerHTML = `
      <div class="community-photo-placeholder">
        Loading photo...
      </div>
    `;

    const photo =
      await loadPhoto(currentIndex);

    carousel.innerHTML = `
      ${
        photo.imageUrl
          ? `
            <img
              class="detail-photo"
              src="${photo.imageUrl}"
              alt="${photo.placeName}"
              loading="lazy"
            >
          `
          : `
            <div class="community-photo-placeholder">
              No photo available
            </div>
          `
      }

      <div class="detail-photo-label">
        ${photo.placeName}
      </div>

      <div class="detail-photo-count">
        ${currentIndex + 1} / ${candidateStops.length}
      </div>

      ${
        candidateStops.length > 1
          ? `
            <button
              class="detail-carousel-btn detail-carousel-prev"
              type="button"
            >
              ‹
            </button>

            <button
              class="detail-carousel-btn detail-carousel-next"
              type="button"
            >
              ›
            </button>
          `
          : ""
      }
    `;

    if (candidateStops.length > 1) {
      carousel
        .querySelector(".detail-carousel-prev")
        .addEventListener("click", async (event) => {
          event.stopPropagation();

          currentIndex =
            (currentIndex - 1 + candidateStops.length) %
            candidateStops.length;

          await renderDetailPhoto();
        });

      carousel
        .querySelector(".detail-carousel-next")
        .addEventListener("click", async (event) => {
          event.stopPropagation();

          currentIndex =
            (currentIndex + 1) %
            candidateStops.length;

          await renderDetailPhoto();
        });
    }
  }

  await renderDetailPhoto();
}

let publicDetailMap = null;
let publicDetailMapRequest = 0;

function normaliseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getPublicStopPoint(stop) {
  const latitude = normaliseNumber(
    stop.latitude ??
    stop.lat
  );

  const longitude = normaliseNumber(
    stop.longitude ??
    stop.lng ??
    stop.lon
  );

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude
  };
}

function getPublicItineraryPoint(item, prefix) {
  const latitude = normaliseNumber(item?.[`${prefix}_latitude`]);
  const longitude = normaliseNumber(item?.[`${prefix}_longitude`]);

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude
  };
}

const PUBLIC_DAY_ROUTE_COLORS = ["#15956f", "#2563eb", "#d97706", "#db2777", "#7c3aed", "#dc2626"];

function getPublicTripDays(item) {
  const days = Math.round(Number(item?.trip_days || item?.day_count || 1));
  return Math.min(30, Math.max(1, Number.isFinite(days) ? days : 1));
}

function normalisePublicDayNumber(item, value) {
  const dayNumber = Math.round(Number(value || 1));
  return Math.min(
    getPublicTripDays(item),
    Math.max(1, Number.isFinite(dayNumber) ? dayNumber : 1)
  );
}

function getPublicDayRouteColor(dayNumber) {
  return PUBLIC_DAY_ROUTE_COLORS[(Math.max(1, Number(dayNumber) || 1) - 1) % PUBLIC_DAY_ROUTE_COLORS.length];
}

function getPublicDayRouteDashArray(dayNumber) {
  return [null, "14 8", "4 8", "14 6 3 6", "2 8", "18 4"][
    (Math.max(1, Number(dayNumber) || 1) - 1) % 6
  ];
}

function getPublicDayMapSections(item) {
  const startPoint = getPublicItineraryPoint(item, "start");
  const endPoint = getPublicItineraryPoint(item, "end");
  const numberedStops = (item.stopList || []).map((stop, index) => ({
    stop,
    marker: index + 1,
    dayNumber: normalisePublicDayNumber(item, stop.day_number || stop.day || 1),
    point: getPublicStopPoint(stop)
  })).filter(entry => entry.point);
  const dayNumbers = [...new Set(numberedStops.map(entry => entry.dayNumber))];
  const sections = dayNumbers.map(dayNumber => {
    const dayStops = numberedStops.filter(entry => entry.dayNumber === dayNumber);
    const previousStop = [...numberedStops].reverse().find(entry => entry.dayNumber < dayNumber);
    const originPoint = dayNumber === 1
      ? startPoint
      : previousStop?.point || startPoint;
    const points = [originPoint, ...dayStops.map(entry => entry.point)].filter(Boolean);

    if (dayNumber === getPublicTripDays(item) && endPoint) {
      points.push(endPoint);
    }

    return { dayNumber, points };
  }).filter(section => section.points.length > 1);

  const lastStop = numberedStops[numberedStops.length - 1];
  if (endPoint && (!lastStop || lastStop.dayNumber < getPublicTripDays(item))) {
    const originPoint = lastStop?.point || startPoint;
    if (originPoint) {
      sections.push({
        dayNumber: getPublicTripDays(item),
        points: [originPoint, endPoint]
      });
    }
  }

  return sections;
}

async function renderPublicRouteMap(item) {
  const mapElement = document.getElementById(
    "publicDetailRouteMap"
  );

  if (!mapElement || typeof L === "undefined") {
    return;
  }

  const requestId = publicDetailMapRequest + 1;
  publicDetailMapRequest = requestId;

  if (publicDetailMap) {
    publicDetailMap.remove();
    publicDetailMap = null;
  }

  mapElement.innerHTML = "";

  const mapPoints = [];
  console.log(
    "[PUBLIC MAP STOP LIST]",
    item.stopList
  );

  const startPoint = getPublicItineraryPoint(item, "start");
  const endPoint = getPublicItineraryPoint(item, "end");

  if (startPoint) {
    mapPoints.push({
      label: `Start: ${item.start_location_name || "Start Location"}`,
      latitude: startPoint.latitude,
      longitude: startPoint.longitude,
      type: "start",
      markerLabel: "S"
    });
  }

  (item.stopList || []).forEach((stop, index) => {
    const point = getPublicStopPoint(stop);

    if (!point) return;

    mapPoints.push({
      label: `${index + 1}. ${
        stop.stop_name ||
        stop.place ||
        "Stop"
      } (Day ${normalisePublicDayNumber(item, stop.day_number || stop.day || 1)})`,
      latitude: point.latitude,
      longitude: point.longitude,
      type: "stop",
      markerLabel: String(index + 1)
    });
  });

  if (endPoint) {
    mapPoints.push({
      label: `End: ${item.end_location_name || item.destination || "End Location"}`,
      latitude: endPoint.latitude,
      longitude: endPoint.longitude,
      type: "end",
      markerLabel: "E"
    });
  }

  if (!mapPoints.length) {
    console.log(
      "[PUBLIC MAP POINTS]",
      mapPoints
    );
    mapElement.innerHTML = `
      <div class="community-photo-placeholder">
        No route coordinates available
      </div>
    `;
    return;
  }

  publicDetailMap = L.map(
    "publicDetailRouteMap"
  );

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }
  ).addTo(publicDetailMap);

  const markerGroup = L.featureGroup();

  mapPoints.forEach((point, index) => {
    const markerLabel = point.markerLabel || String(index + 1);
    const markerClass = point.type === "start" || point.type === "end"
      ? `public-map-marker ${point.type}`
      : "public-map-marker stop";

    const icon = L.divIcon({
      className: "",
      html: `
        <div class="${markerClass}">
          ${markerLabel}
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -16]
    });

    const marker = L.marker(
      [point.latitude, point.longitude],
      {
        icon,
        zIndexOffset: point.type === "start"
          ? 1000
          : point.type === "end"
            ? 900
            : Math.max(0, 500 - Number(point.markerLabel || 0))
      }
    )
      .bindPopup(point.label)
      .addTo(publicDetailMap);

    markerGroup.addLayer(marker);
  });

  const daySections = getPublicDayMapSections(item);
  const routeGeometries = await Promise.all(
    daySections.map(section => getPublicRoadRouteGeometry(section.points))
  );

  if (requestId !== publicDetailMapRequest || !publicDetailMap) {
    return;
  }

  daySections.forEach((section, index) => {
    const style = {
      color: getPublicDayRouteColor(section.dayNumber),
      weight: 5,
      opacity: 0.85,
      dashArray: getPublicDayRouteDashArray(section.dayNumber),
      lineCap: "round",
      lineJoin: "round"
    };
    const geometry = routeGeometries[index];
    const layer = geometry
      ? L.geoJSON(geometry, { style }).addTo(publicDetailMap)
      : L.polyline(
        section.points.map(point => [point.latitude, point.longitude]),
        style
      ).addTo(publicDetailMap);

    layer.bindTooltip(`Day ${section.dayNumber}`);
  });

  if (mapPoints.length === 1) {
    publicDetailMap.setView([mapPoints[0].latitude, mapPoints[0].longitude], 14);
  } else {
    publicDetailMap.fitBounds(markerGroup.getBounds(), {padding: [20, 20]});
  }

  setTimeout(() => {publicDetailMap.invalidateSize();}, 100);
}

async function getPublicRoadRouteGeometry(mapPoints) {
  if (!mapPoints || mapPoints.length < 2) {
    return null;
  }

  const coordinates = mapPoints
    .map((point) => {
      return `${point.longitude},${point.latitude}`;
    })
    .join(";");

  const routeUrl =
    `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
    `?overview=full&geometries=geojson`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  try {
    const response = await fetch(routeUrl, { signal: controller.signal });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.routes || !data.routes.length) {
      return null;
    }

    return data.routes[0].geometry;

  } catch (error) {
    console.error(
      "Public route failed:",
      error
    );

    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

window.loadCommunityPhoto = loadCommunityPhoto;
window.loadDetailPhotoCarousel = loadDetailPhotoCarousel;
window.renderPublicRouteMap = renderPublicRouteMap;
