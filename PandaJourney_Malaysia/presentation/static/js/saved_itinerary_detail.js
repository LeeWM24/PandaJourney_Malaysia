import {
  auth,
  db
} from "./firebase-config.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const ITINERARY_COLLECTION = "Itinerary";
const ITINERARY_STOP_COLLECTION = "itinerary_stops";
const COLLABORATOR_COLLECTION = "collaborators";

const pageElement = document.getElementById("saved-detail-page");
const loadingElement = document.getElementById("detail-loading");
const errorElement = document.getElementById("detail-error");
const contentElement = document.getElementById("detail-content");

let detailMap = null;
const placePhotoCache = new Map();

// ================================
// Itinerary ID
// ================================

function getItineraryIdFromPage() {
  const fromDataset = pageElement ? pageElement.dataset.itineraryId : "";

  if (fromDataset && fromDataset.trim()) {
    return fromDataset.trim();
  }

  const pathParts = window.location.pathname
    .split("/")
    .filter(Boolean);

  return pathParts.length
    ? decodeURIComponent(pathParts[pathParts.length - 1])
    : "";
}

const itineraryId = getItineraryIdFromPage();

console.log("[Saved Detail] itineraryId:", itineraryId);

// ================================
// Helper
// ================================

function hideLoading() {
  if (loadingElement) {
    loadingElement.style.display = "none";
  }
}

function showError() {
  hideLoading();

  if (contentElement) {
    contentElement.style.display = "none";
  }

  if (errorElement) {
    errorElement.style.display = "block";
  }
}

function showContent() {
  hideLoading();

  if (errorElement) {
    errorElement.style.display = "none";
  }

  if (contentElement) {
    contentElement.style.display = "block";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const MAX_TITLE_DISPLAY_LENGTH = 50;
const MAX_LOCATION_DISPLAY_LENGTH = 40;

function truncateText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 3)).trimEnd() + "...";
}

function shortLocationName(value, maxLength = MAX_LOCATION_DISPLAY_LENGTH) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.toLowerCase() === "current location") return "Current Location";

  const parts = text.split(",").map(part => part.trim()).filter(Boolean);
  let shortName = parts[0] || text;

  if (/^\d+$/.test(shortName.replace(/\s+/g, "")) && parts.length > 1) {
    shortName = `${shortName}, ${parts[1]}`;
  }

  return truncateText(shortName, maxLength);
}

function setText(id, value, fullValue = "") {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value || "-";

    if (fullValue && String(fullValue) !== String(value || "")) {
      element.title = String(fullValue);
    } else {
      element.removeAttribute("title");
    }
  }
}

function formatDate(dateText) {
  if (!dateText) return "No date";

  const date = new Date(dateText);

  if (Number.isNaN(date.getTime())) {
    return dateText;
  }

  return date.toLocaleDateString("en-MY", {
    year: "numeric",
    month: "short",
    day: "2-digit"
  });
}

function getTripDays(itinerary) {
  const days = Math.round(Number(itinerary?.trip_days || itinerary?.day_count || 1));
  return Math.min(30, Math.max(1, Number.isFinite(days) ? days : 1));
}

function normaliseDayNumber(itinerary, value) {
  const dayNumber = Math.round(Number(value || 1));
  return Math.min(getTripDays(itinerary), Math.max(1, Number.isFinite(dayNumber) ? dayNumber : 1));
}

function addDaysToDate(dateText, daysToAdd) {
  if (!dateText) return "";
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + daysToAdd);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTripDateRange(itinerary) {
  const days = getTripDays(itinerary);
  const startDate = itinerary?.travel_date || "";
  const endDate = addDaysToDate(startDate, days - 1);

  if (days <= 1) return formatDate(startDate);
  if (!startDate || !endDate) return `${days} days`;
  return `${formatDate(startDate)} - ${formatDate(endDate)} (${days} days)`;
}

function formatMinutes(minutes) {
  const value = Number(minutes || 0);

  if (!value) return "Estimated";

  if (value < 60) {
    return `${value} min`;
  }

  const hours = Math.floor(value / 60);
  const remainder = value % 60;

  if (remainder === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${remainder} min`;
}

function getDayStartTimes(itinerary) {
  const savedTimes = itinerary?.day_start_times && typeof itinerary.day_start_times === "object"
    ? itinerary.day_start_times
    : {};
  const fallbackTime = itinerary?.start_time || "09:00";
  const result = {};

  for (let dayNumber = 1; dayNumber <= getTripDays(itinerary); dayNumber += 1) {
    result[String(dayNumber)] = savedTimes[String(dayNumber)] || fallbackTime;
  }

  return result;
}

function getDayStartTime(itinerary, dayNumber) {
  const safeDayNumber = normaliseDayNumber(itinerary, dayNumber);
  return getDayStartTimes(itinerary)[String(safeDayNumber)] || itinerary?.start_time || "09:00";
}

function formatRouteSummary(itinerary) {
  const startName = getStartDisplayName(itinerary);
  const endName = getEndDisplayName(itinerary);

  if (startName && endName) {
    return `${startName} -> ${endName}`;
  }

  return endName || startName || itinerary?.destination || "Malaysia";
}

function parseClockMinutes(value) {
  const text = String(value || "").trim();
  if (!text) return 9 * 60;

  const amPmMatch = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (amPmMatch) {
    let hour = Number(amPmMatch[1]);
    const minute = Number(amPmMatch[2]);
    const period = amPmMatch[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + minute;
  }

  const twentyFourHourMatch = text.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    return Number(twentyFourHourMatch[1]) * 60 + Number(twentyFourHourMatch[2]);
  }

  return 9 * 60;
}

function formatClockMinutes(value) {
  const total = ((Math.round(Number(value || 0)) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatAvailableHours(itinerary) {
  if (
    itinerary.available_hours_unlimited ||
    String(itinerary.available_hours || "").toLowerCase() === "unlimited"
  ) {
    return "No time limit";
  }

  return itinerary.available_hours ? `${itinerary.available_hours} hrs` : "Estimated";
}

function getBadgeClass(status) {
  if (status === "Published") return "badge-success";
  if (status === "Draft") return "badge-warning";
  if (status === "Upcoming") return "badge-info";
  return "badge-muted";
}

function updateStatusBadge(status) {
  const badge = document.getElementById("detail-status");

  if (!badge) return;

  badge.className = `badge ${getBadgeClass(status)}`;
  badge.textContent = status || "Draft";
}

function normaliseNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getFirstValue(object, keys) {
  for (const key of keys) {
    if (
      object &&
      object[key] !== undefined &&
      object[key] !== null &&
      object[key] !== ""
    ) {
      return object[key];
    }
  }

  return null;
}

function isCurrentLocationName(value) {
  return String(value || "").trim().toLowerCase() === "current location";
}

function isGenericLocationName(value) {
  const name = String(value || "").trim().toLowerCase();
  return [
    "kuala lumpur, malaysia",
    "federal territory of kuala lumpur, malaysia",
    "malaysia"
  ].includes(name);
}

function getStopPlaceName(stop) {
  return String(stop.stop_name || stop.place || "").trim();
}

function getPhotoStops(stops) {
  return (stops || []).filter(function (stop) {
    const placeName = getStopPlaceName(stop);
    return placeName && !isGenericLocationName(placeName);
  });
}

async function getPlacePhoto(placeName) {
  if (placePhotoCache.has(placeName)) {
    return placePhotoCache.get(placeName);
  }

  try {
    const response = await fetch(
      `/api/public-place-photo?name=${encodeURIComponent(placeName)}`
    );
    const data = await response.json();
    const photo = {
      imageUrl: data.image_url || "",
      placeName
    };
    placePhotoCache.set(placeName, photo);
    return photo;
  } catch (error) {
    console.error("Saved detail photo failed:", error);
    const photo = {
      imageUrl: "",
      placeName
    };
    placePhotoCache.set(placeName, photo);
    return photo;
  }
}

function getStartLocationName(itinerary) {
  return (
    itinerary.start_location_name ||
    itinerary.start ||
    "Start Location"
  );
}

function getEndLocationName(itinerary) {
  return (
    itinerary.end_location_name ||
    itinerary.end ||
    itinerary.destination ||
    "End Location"
  );
}

function getStartDisplayName(itinerary) {
  return shortLocationName(getStartLocationName(itinerary)) || "Start Location";
}

function getEndDisplayName(itinerary) {
  return shortLocationName(getEndLocationName(itinerary)) || "End Location";
}

function getStartPoint(itinerary) {
  const latitude = normaliseNumber(
    getFirstValue(itinerary, [
      "start_latitude",
      "start_lat",
      "startLatitude"
    ])
  );

  const longitude = normaliseNumber(
    getFirstValue(itinerary, [
      "start_longitude",
      "start_lng",
      "startLongitude"
    ])
  );

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude
  };
}

function getEndPoint(itinerary) {
  const latitude = normaliseNumber(
    getFirstValue(itinerary, [
      "end_latitude",
      "end_lat",
      "endLatitude"
    ])
  );

  const longitude = normaliseNumber(
    getFirstValue(itinerary, [
      "end_longitude",
      "end_lng",
      "endLongitude"
    ])
  );

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude
  };
}

function getStopPoint(stop) {
  const latitude = normaliseNumber(stop.latitude);
  const longitude = normaliseNumber(stop.longitude);

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude
  };
}

function getRouteSegmentLabel(fromMarker, toMarker) {
  return `Google Maps ${fromMarker} -> ${toMarker}`;
}

function isUsableStop(stop) {
  const stopName = String(stop.stop_name || "").trim().toLowerCase();

  return Boolean(stopName) &&
    stopName !== "new stop" &&
    stopName !== "unnamed stop" &&
    Boolean(getStopPoint(stop));
}

function getLastStopPoint(stops) {
  if (!stops.length) return null;

  for (let index = stops.length - 1; index >= 0; index -= 1) {
    const point = getStopPoint(stops[index]);

    if (point) {
      return point;
    }
  }

  return null;
}

function getLastStopName(stops) {
  if (!stops.length) return "Start Location";

  const lastStop = stops[stops.length - 1];

  return lastStop.stop_name || "Previous Stop";
}

function buildCoordinateText(point) {
  if (!point) return "";

  const latitude = normaliseNumber(point.latitude);
  const longitude = normaliseNumber(point.longitude);

  if (latitude === null || longitude === null) {
    return "";
  }

  return `${latitude.toFixed(7)},${longitude.toFixed(7)}`;
}

function distanceKm(pointA, pointB) {
  if (!pointA || !pointB) return 0;
  const latA = normaliseNumber(pointA.latitude);
  const lngA = normaliseNumber(pointA.longitude);
  const latB = normaliseNumber(pointB.latitude);
  const lngB = normaliseNumber(pointB.longitude);

  if (latA === null || lngA === null || latB === null || lngB === null) {
    return 0;
  }

  const lat1 = latA * Math.PI / 180;
  const lat2 = latB * Math.PI / 180;
  const deltaLat = (latB - latA) * Math.PI / 180;
  const deltaLng = (lngB - lngA) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateTravelMinutes(pointA, pointB) {
  const km = distanceKm(pointA, pointB);
  return km ? Math.max(5, Math.round((km / 35) * 60)) : 0;
}

function getStoredFinalTravelMinutes(itinerary, stops) {
  const savedTravelMinutes = Number(itinerary?.travel_duration_minutes || 0);
  const stopTravelMinutes = stops.reduce((total, stop) => {
    return total + Number(stop.travel_minutes_from_previous || 0);
  }, 0);

  if (savedTravelMinutes > stopTravelMinutes) {
    return Math.max(0, savedTravelMinutes - stopTravelMinutes);
  }

  const lastStopPoint = getLastStopPoint(stops);
  const endPoint = getEndPoint(itinerary);
  return estimateTravelMinutes(lastStopPoint, endPoint);
}

function buildGoogleMapsUrl(originPoint, destinationPoint, useLiveCurrentLocation = false) {
  const destinationText = buildCoordinateText(destinationPoint);

  if (!destinationText) {
    return "";
  }

  const params = new URLSearchParams();

  params.set("api", "1");

  if (!useLiveCurrentLocation && originPoint) {
    const originText = buildCoordinateText(originPoint);

    if (originText) {
      params.set("origin", originText);
    }
  }

  params.set("destination", destinationText);
  params.set("travelmode", "driving");

  if (useLiveCurrentLocation) {
    params.set("dir_action", "navigate");
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function buildGoogleMapsRouteUrl(originPoint, destinationPoint, waypointPoints = [], useLiveCurrentLocation = false) {
  const destinationText = buildCoordinateText(destinationPoint);

  if (!destinationText) {
    return "";
  }

  const params = new URLSearchParams();

  params.set("api", "1");

  if (!useLiveCurrentLocation) {
    const originText = buildCoordinateText(originPoint);

    if (!originText) {
      return "";
    }

    params.set("origin", originText);
  }

  params.set("destination", destinationText);
  params.set("travelmode", "driving");

  const waypointTexts = waypointPoints
    .map(buildCoordinateText)
    .filter(Boolean);

  if (waypointTexts.length) {
    params.set("waypoints", waypointTexts.join("|"));
  }

  if (useLiveCurrentLocation) {
    params.set("dir_action", "navigate");
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function buildFallbackFullRouteUrl(itinerary, stops) {
  const startPoint = getStartPoint(itinerary);
  const endPoint = getEndPoint(itinerary);

  if (!endPoint) {
    return "";
  }

  const useLiveCurrentLocation = isCurrentLocationName(
    itinerary.start_location_name
  );

  const waypointPoints = stops
    .map(getStopPoint)
    .filter(Boolean);

  return buildGoogleMapsRouteUrl(
    startPoint,
    endPoint,
    waypointPoints,
    useLiveCurrentLocation
  );
}

async function getRoadRouteGeometry(mapPoints) {
  if (!mapPoints || mapPoints.length < 2) {
    return null;
  }

  const coordinates = mapPoints
    .map(function (point) {
      return `${point.longitude},${point.latitude}`;
    })
    .join(";");

  const routeUrl =
    `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
    `?overview=full&geometries=geojson`;

  try {
    const response = await fetch(routeUrl);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.routes || !data.routes.length) {
      return null;
    }

    return data.routes[0].geometry;

  } catch (error) {
    console.error("Failed to load OSRM route:", error);
    return null;
  }
}

// ================================
// Firebase Load
// ================================

async function userCanViewItinerary(user, itineraryData, resolvedItineraryId) {
  if (!user || !itineraryData || !resolvedItineraryId) {
    return false;
  }

  if (itineraryData.user_id === user.uid || itineraryData.status === "Published") {
    return true;
  }

  const collaboratorQuery = query(
    collection(db, COLLABORATOR_COLLECTION),
    where("itinerary_id", "==", resolvedItineraryId),
    where("user_id", "==", user.uid),
    where("status", "==", "accepted")
  );

  const snapshot = await getDocs(collaboratorQuery);

  return !snapshot.empty;
}

async function getItinerary(user) {
  if (!itineraryId) {
    console.error("[Saved Detail] Missing itinerary id.");
    return null;
  }

  console.log("[Saved Detail] current user uid:", user.uid);
  console.log("[Saved Detail] searching itinerary:", itineraryId);

  const directDocRef = doc(db, ITINERARY_COLLECTION, itineraryId);
  const directDocSnap = await getDoc(directDocRef);

  if (directDocSnap.exists()) {
    const data = directDocSnap.data();
    const resolvedItineraryId = data.itinerary_id || directDocSnap.id;

    console.log("[Saved Detail] direct document found:", data);

    if (!(await userCanViewItinerary(user, data, resolvedItineraryId))) {
      console.warn("[Saved Detail] permission mismatch:", {
        documentUserId: data.user_id,
        currentUserId: user.uid,
        status: data.status,
        itineraryId: resolvedItineraryId
      });

      return null;
    }

    return {
    ...data,
    document_id: directDocSnap.id,
    itinerary_id: resolvedItineraryId
  };
}

  const itineraryQuery = query(
    collection(db, ITINERARY_COLLECTION),
    where("itinerary_id", "==", itineraryId)
  );

  const snapshot = await getDocs(itineraryQuery);

  if (snapshot.empty) {
    console.warn("[Saved Detail] no document found by itinerary_id.");
    return null;
  }

  const docSnap = snapshot.docs[0];
  const data = docSnap.data();
  const resolvedItineraryId = data.itinerary_id || docSnap.id;

  console.log("[Saved Detail] fallback document found:", data);

  if (!(await userCanViewItinerary(user, data, resolvedItineraryId))) {
    console.warn("[Saved Detail] permission mismatch:", {
      documentUserId: data.user_id,
      currentUserId: user.uid,
      status: data.status,
      itineraryId: resolvedItineraryId
    });

    return null;
  }

  return {
    ...data,
    document_id: docSnap.id,
    itinerary_id: resolvedItineraryId
  };
}

async function getItineraryStops(targetItineraryIds) {
  const ids = Array.from(new Set(
    (Array.isArray(targetItineraryIds) ? targetItineraryIds : [targetItineraryIds])
      .filter(Boolean)
  ));
  const mergedStops = new Map();

  for (const targetItineraryId of ids) {
    const stopsQuery = query(
      collection(db, ITINERARY_STOP_COLLECTION),
      where("itinerary_id", "==", targetItineraryId)
    );

    const snapshot = await getDocs(stopsQuery);

    snapshot.forEach(function (docSnap) {
      mergedStops.set(docSnap.id, {
        document_id: docSnap.id,
        ...docSnap.data()
      });
    });
  }

  return Array.from(mergedStops.values()).sort(function (a, b) {
    const dayDifference = Number(a.day_number || 1) - Number(b.day_number || 1);
    if (dayDifference) return dayDifference;
    return Number(a.stop_order || 0) - Number(b.stop_order || 0);
  });
}

async function loadDetail(user) {
  const itinerary = await getItinerary(user);

  if (!itinerary) {
    showError();
    return;
  }

  const targetItineraryIds = [
    itinerary.itinerary_id,
    itinerary.document_id,
    itineraryId
  ];

  const stops = (await getItineraryStops(targetItineraryIds)).filter(isUsableStop);

  renderItinerary(itinerary, stops);
  renderDetailStops(itinerary, stops);
  renderPhotoCarousel(stops).catch(function (error) {
    console.error("Failed to render itinerary photos:", error);
  });

  showContent();

  setTimeout(function () {
    renderMap(itinerary, stops).catch(function (error) {
      console.error("Failed to render map:", error);
    });
  }, 300);
}

// ================================
// Render
// ================================

function renderItinerary(itinerary, stops) {
  const stopCount =
    itinerary.stop_count ||
    stops.length ||
    0;

  const fullTitle = itinerary.title || "Untitled Trip";
  const fullStartName = getStartLocationName(itinerary);
  const fullEndName = getEndLocationName(itinerary);

  setText("detail-title", truncateText(fullTitle, MAX_TITLE_DISPLAY_LENGTH), fullTitle);
  setText(
    "detail-destination",
    formatRouteSummary(itinerary),
    `${fullStartName} -> ${fullEndName}`
  );
  setText("detail-date", formatTripDateRange(itinerary));
  setText("detail-start", getStartDisplayName(itinerary), fullStartName);
  setText("detail-end", getEndDisplayName(itinerary), fullEndName);
  setText("detail-hours", formatAvailableHours(itinerary));

  if (Array.isArray(itinerary.interests) && itinerary.interests.length) {
    setText("detail-interest", itinerary.interests.join(", "));
  } else {
    setText("detail-interest", itinerary.interest || "-");
  }

  setText("detail-stop-count", `${stopCount} stops`);
  setText("detail-travel-duration", formatMinutes(itinerary.travel_duration_minutes));

  updateStatusBadge(itinerary.status || "Draft");

  const rebuiltFullRouteUrl = buildFallbackFullRouteUrl(itinerary, stops);
  const fullRouteUrl = rebuiltFullRouteUrl || itinerary.google_maps_full_route_url || "";

  renderFullGoogleRouteAction(fullRouteUrl);
  renderEndLocationAction(itinerary, stops);
}

async function renderPhotoCarousel(stops) {
  const carousel = document.getElementById("saved-detail-photo-carousel");

  if (!carousel) return;

  const photoStops = getPhotoStops(stops);

  if (!photoStops.length) {
    carousel.innerHTML = `
      <div class="community-photo-placeholder">
        No photo available
      </div>
    `;
    return;
  }

  let currentIndex = 0;

  async function renderPhoto() {
    carousel.innerHTML = `
      <div class="community-photo-placeholder">
        Loading photo...
      </div>
    `;

    const placeName = getStopPlaceName(photoStops[currentIndex]);
    const photo = await getPlacePhoto(placeName);

    carousel.innerHTML = `
      ${
        photo.imageUrl
          ? `
            <img
              class="saved-detail-photo"
              src="${escapeHtml(photo.imageUrl)}"
              alt="${escapeHtml(photo.placeName)}"
              loading="lazy"
            >
          `
          : `
            <div class="community-photo-placeholder">
              No photo available
            </div>
          `
      }
      <div class="saved-detail-photo-label">
        ${escapeHtml(photo.placeName)}
      </div>
      <div class="saved-detail-photo-count">
        ${currentIndex + 1} / ${photoStops.length}
      </div>
      ${
        photoStops.length > 1
          ? `
            <button class="saved-detail-carousel-btn saved-detail-carousel-prev" type="button" aria-label="Previous photo">&lsaquo;</button>
            <button class="saved-detail-carousel-btn saved-detail-carousel-next" type="button" aria-label="Next photo">&rsaquo;</button>
          `
          : ""
      }
    `;

    carousel.querySelector(".saved-detail-carousel-prev")?.addEventListener("click", function () {
      currentIndex = (currentIndex - 1 + photoStops.length) % photoStops.length;
      renderPhoto().catch(console.error);
    });

    carousel.querySelector(".saved-detail-carousel-next")?.addEventListener("click", function () {
      currentIndex = (currentIndex + 1) % photoStops.length;
      renderPhoto().catch(console.error);
    });
  }

  await renderPhoto();
}

function renderFullGoogleRouteAction(url) {
  const action = document.getElementById("detail-full-route-action");
  const link = document.getElementById("detail-google-full-route-link");

  if (!action || !link) {
    return;
  }

  if (!url) {
    action.style.display = "none";
    link.removeAttribute("href");
    return;
  }

  link.href = url;
  action.style.display = "flex";
}

function renderEndLocationAction(itinerary, stops) {
  const endElement = document.getElementById("detail-end");

  if (!endElement) {
    return;
  }

  const endCard = endElement.parentElement;

  if (!endCard) {
    return;
  }

  const oldAction = document.getElementById("detail-end-route-action");

  if (oldAction) {
    oldAction.remove();
  }

  const endPoint = getEndPoint(itinerary);

  if (!endPoint) {
    return;
  }

  const startPoint = getStartPoint(itinerary);
  const lastStopPoint = getLastStopPoint(stops);

  const originPoint = lastStopPoint || startPoint;

  const useLiveCurrentLocation =
    !lastStopPoint &&
    isCurrentLocationName(itinerary.start_location_name);

  const googleMapsUrl = buildGoogleMapsUrl(
    originPoint,
    endPoint,
    useLiveCurrentLocation
  );

  if (!googleMapsUrl) {
    return;
  }

  endCard.classList.add("end-location-card");

  const actionWrapper = document.createElement("div");
  actionWrapper.id = "detail-end-route-action";
  actionWrapper.className = "end-location-action";

  actionWrapper.innerHTML = `
    <a 
      href="${escapeHtml(googleMapsUrl)}" 
      target="_blank" 
      rel="noopener noreferrer" 
      class="btn btn-secondary btn-sm end-route-btn"
    >
      Google Maps
    </a>
  `;

  endCard.appendChild(actionWrapper);
}

function renderDetailStops(itinerary, stops) {
  const stopList = document.getElementById("detail-stop-list");

  if (!stopList) return;

  stopList.innerHTML = "";

  const routeRows = [];
  const startName = getStartDisplayName(itinerary);
  const endName = getEndDisplayName(itinerary);
  const dayStartTimes = getDayStartTimes(itinerary);
  const startTime = formatClockMinutes(parseClockMinutes(dayStartTimes["1"] || itinerary.start_time || "09:00"));
  const lastStop = stops.length ? stops[stops.length - 1] : null;
  const finalTravelMinutes = getStoredFinalTravelMinutes(itinerary, stops);
  const lastStopEndMinutes = lastStop
    ? parseClockMinutes(lastStop.departure_time || lastStop.arrival_time || "")
    : 0;
  const endTime = lastStop && finalTravelMinutes
    ? formatClockMinutes(lastStopEndMinutes + finalTravelMinutes)
    : lastStop?.departure_time || lastStop?.arrival_time || "";

  if (startName) {
    routeRows.push({
      type: "marker",
      marker: "S",
      label: "Start",
      title: startName,
      meta: `Starting location - Start time: ${startTime}`
    });
  }

  let lastDayNumber = 0;

  stops.forEach(function (stop, index) {
    const dayNumber = normaliseDayNumber(itinerary, stop.day_number || stop.day || 1);

    if (dayNumber !== lastDayNumber) {
      routeRows.push({
        type: "day",
        dayNumber,
        title: `Day ${dayNumber}`,
        meta: `Starts ${formatClockMinutes(parseClockMinutes(getDayStartTime(itinerary, dayNumber)))}`
      });
      lastDayNumber = dayNumber;
    }

    routeRows.push({
      type: "stop",
      marker: String(index + 1),
      stop,
      index,
      dayNumber
    });
  });

  if (endName) {
    routeRows.push({
      type: "marker",
      marker: "E",
      label: "End",
      title: endName,
      meta: endTime
        ? `Ending location - End time: ${endTime}`
        : "Ending location"
    });
  }

  if (!routeRows.length) {
    stopList.innerHTML = `
      <div class="empty-state" style="padding:28px;">
        <div class="empty-title">No stops found</div>
        <div class="empty-sub">This saved itinerary has no stop record.</div>
      </div>
    `;
    return;
  }

  routeRows.forEach(function (routeRow) {
    const row = document.createElement("div");
    row.className = `detail-stop-row ${routeRow.type === "marker" ? "detail-route-marker-row" : ""} ${routeRow.type === "day" ? "detail-day-row" : ""}`;

    if (routeRow.type === "day") {
      row.innerHTML = `
        <div class="detail-day-divider">
          <span>${escapeHtml(routeRow.title)} - ${escapeHtml(routeRow.meta)}</span>
        </div>
      `;

      stopList.appendChild(row);
      return;
    }

    if (routeRow.type === "marker") {
      row.innerHTML = `
        <div class="detail-stop-number">${escapeHtml(routeRow.marker)}</div>
        <div class="detail-stop-content">
          <div class="detail-route-marker-label">${escapeHtml(routeRow.label)}</div>
          <div class="detail-stop-title">${escapeHtml(routeRow.title)}</div>
          <div class="detail-stop-meta">${escapeHtml(routeRow.meta)}</div>
        </div>
      `;

      stopList.appendChild(row);
      return;
    }

    const stop = routeRow.stop;
    const index = routeRow.index;
    const arrivalTime = stop.arrival_time || "";
    const departureTime = stop.departure_time || "";
    const timeText = departureTime
      ? `${arrivalTime} - ${departureTime}`
      : arrivalTime || "Time not available";
    const originPoint = index === 0
      ? getStartPoint(itinerary)
      : getStopPoint(stops[index - 1]);
    const useLiveCurrentLocation =
      index === 0 &&
      isCurrentLocationName(itinerary.start_location_name);
    const originLabel = index === 0
      ? useLiveCurrentLocation
        ? "Current Location"
        : getStartDisplayName(itinerary)
      : stops[index - 1].stop_name || "Previous Stop";
    const destinationPoint = getStopPoint(stop);
    const googleMapsUrl = buildGoogleMapsUrl(
      originPoint,
      destinationPoint,
      useLiveCurrentLocation
    );
    const segmentLabel = getRouteSegmentLabel(
      index === 0 ? "S" : String(index),
      String(index + 1)
    );
    let googleMapsButton = googleMapsUrl
      ? `
        <a
          href="${escapeHtml(googleMapsUrl)}"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-secondary btn-sm"
          title="Google Maps: ${escapeHtml(originLabel)} -> ${escapeHtml(stop.stop_name || "Stop")}"
        >
          ${escapeHtml(segmentLabel)}
        </a>
      `
      : "";

    if (index === stops.length - 1) {
      const endPoint = getEndPoint(itinerary);
      const endMapsUrl = buildGoogleMapsUrl(destinationPoint, endPoint);

      if (endMapsUrl) {
        const returnSegmentLabel = getRouteSegmentLabel(String(index + 1), "E");

        googleMapsButton += `
          <a
            href="${escapeHtml(endMapsUrl)}"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-secondary btn-sm"
            title="Google Maps: ${escapeHtml(stop.stop_name || "Stop")} -> ${escapeHtml(getEndDisplayName(itinerary))}"
          >
            ${escapeHtml(returnSegmentLabel)}
          </a>
        `;
      }
    }

    row.innerHTML = `
      <div class="detail-stop-number">${escapeHtml(routeRow.marker)}</div>
      <div class="detail-stop-content">
        <div class="detail-stop-title">${escapeHtml(stop.stop_name || "Unnamed Stop")}</div>
        <div class="detail-stop-meta">
          ${escapeHtml(timeText)}
          <br>
          Rating: ${escapeHtml(stop.rating || "-")}
          &nbsp;·&nbsp;
          Category: ${escapeHtml(stop.category || "-")}
          &nbsp;·&nbsp;
          Visit: ${escapeHtml(formatMinutes(stop.visit_duration_minutes))}
        </div>
        <div class="detail-stop-action-row detail-stop-actions">
          ${googleMapsButton}
        </div>
      </div>
    `;

    stopList.appendChild(row);
  });
}

function renderStops(itinerary, stops) {
  const stopList = document.getElementById("detail-stop-list");

  if (!stopList) return;

  stopList.innerHTML = "";

  if (!stops.length) {
    stopList.innerHTML = `
      <div class="empty-state" style="padding:28px;">
        <div class="empty-icon">📍</div>
        <div class="empty-title">No stops found</div>
        <div class="empty-sub">This saved itinerary has no stop record.</div>
      </div>
    `;
    return;
  }

  stops.forEach(function (stop, index) {
    const row = document.createElement("div");
    row.className = "detail-stop-row";

    const arrivalTime = stop.arrival_time || "";
    const departureTime = stop.departure_time || "";
    const timeText = departureTime
      ? `${arrivalTime} – ${departureTime}`
      : arrivalTime || "Time not available";

    let originPoint = null;
    let useLiveCurrentLocation = false;
    let originLabel = "Previous Stop";

    if (index === 0) {
      originPoint = getStartPoint(itinerary);
      useLiveCurrentLocation = isCurrentLocationName(
        itinerary.start_location_name
      );
      originLabel = useLiveCurrentLocation
        ? "Current Location"
        : getStartDisplayName(itinerary);
    } else {
      originPoint = getStopPoint(stops[index - 1]);
      originLabel = stops[index - 1].stop_name || "Previous Stop";
    }

    const destinationPoint = getStopPoint(stop);

    const googleMapsUrl = buildGoogleMapsUrl(
      originPoint,
      destinationPoint,
      useLiveCurrentLocation
    );

    const googleMapsLabel =
      `Google Maps: ${originLabel} → ${stop.stop_name || "Stop"}`;

    const googleMapsButton = googleMapsUrl
      ? `
        <div class="detail-stop-actions" style="margin-top:10px;">
          <a href="${escapeHtml(googleMapsUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">
            ${escapeHtml(googleMapsLabel)}
          </a>
        </div>
      `
      : "";

    row.innerHTML = `
      <div class="detail-stop-number">
        ${index + 1}
      </div>

      <div class="detail-stop-content">
        <div class="detail-stop-title">
          ${escapeHtml(stop.stop_name || "Unnamed Stop")}
        </div>

        <div class="detail-stop-meta">
          🕒 ${escapeHtml(timeText)}
          <br>
          ⭐ Rating: ${escapeHtml(stop.rating || "-")}
          &nbsp;·&nbsp;
          🏷 Category: ${escapeHtml(stop.category || "-")}
          &nbsp;·&nbsp;
          ⏱ Visit: ${escapeHtml(formatMinutes(stop.visit_duration_minutes))}
        </div>

        ${googleMapsButton}
      </div>
    `;

    stopList.appendChild(row);
  });
}

async function renderMap(itinerary, stops) {
  const mapElement = document.getElementById("detailRouteMap");

  if (!mapElement || typeof L === "undefined") return;

  if (detailMap) {
    detailMap.remove();
    detailMap = null;
  }

  mapElement.innerHTML = "";

  const startPoint = getStartPoint(itinerary);
  const endPoint = getEndPoint(itinerary);

  const mapPoints = [];

  if (startPoint) {
    mapPoints.push({
      label: `Start: ${getStartDisplayName(itinerary)}`,
      latitude: startPoint.latitude,
      longitude: startPoint.longitude
    });
  }

  stops.forEach(function (stop, index) {
    const stopPoint = getStopPoint(stop);

    if (stopPoint) {
      mapPoints.push({
        label: `${index + 1}. ${stop.stop_name || "Stop"}`,
        latitude: stopPoint.latitude,
        longitude: stopPoint.longitude
      });
    }
  });

  if (endPoint) {
    mapPoints.push({
      label: `End: ${getEndDisplayName(itinerary)}`,
      latitude: endPoint.latitude,
      longitude: endPoint.longitude
    });
  } else {
    console.warn("[Saved Detail] End location coordinate missing:", {
      end_location_name: itinerary.end_location_name,
      end_latitude: itinerary.end_latitude,
      end_longitude: itinerary.end_longitude
    });
  }

  console.log("[Saved Detail] mapPoints:", mapPoints);

  if (!mapPoints.length) {
    mapElement.innerHTML = "No map coordinates available.";
    return;
  }

  detailMap = L.map("detailRouteMap");

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(detailMap);

  const markerGroup = L.featureGroup();

  mapPoints.forEach(function (point) {
    const marker = L.marker([point.latitude, point.longitude])
      .bindPopup(point.label)
      .addTo(detailMap);

    markerGroup.addLayer(marker);
  });

  const roadRouteGeometry = await getRoadRouteGeometry(mapPoints);

  let routeLayer = null;

  if (roadRouteGeometry) {
    routeLayer = L.geoJSON(roadRouteGeometry).addTo(detailMap);
  } else {
    const polylinePoints = mapPoints.map(function (point) {
      return [point.latitude, point.longitude];
    });

    if (polylinePoints.length >= 2) {
      routeLayer = L.polyline(polylinePoints).addTo(detailMap);
    }
  }

  detailMap.setView([mapPoints[0].latitude, mapPoints[0].longitude], 13);

  setTimeout(function () {
    detailMap.invalidateSize();

    if (routeLayer && routeLayer.getBounds && routeLayer.getBounds().isValid()) {
      detailMap.fitBounds(routeLayer.getBounds(), {
        padding: [24, 24]
      });
    } else if (markerGroup.getLayers().length > 0) {
      detailMap.fitBounds(markerGroup.getBounds(), {
        padding: [24, 24]
      });
    }
  }, 300);
}

// ================================
// Init
// ================================

onAuthStateChanged(auth, function (user) {
  if (!user) {
    showError();
    return;
  }

  loadDetail(user).catch(function (error) {
    console.error("Failed to load itinerary detail:", error);
    showError();
  });
});
