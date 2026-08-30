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

const pageElement = document.getElementById("saved-detail-page");
const loadingElement = document.getElementById("detail-loading");
const errorElement = document.getElementById("detail-error");
const contentElement = document.getElementById("detail-content");

let detailMap = null;

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

function setText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value || "-";
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

function isUsableStop(stop) {
  const name = String(stop.stop_name || "").trim().toLowerCase();
  const latitude = normaliseNumber(stop.latitude);
  const longitude = normaliseNumber(stop.longitude);
  return Boolean(name) && name !== "new stop" && latitude !== null && longitude !== null;
}

function isCurrentLocationName(value) {
  return String(value || "").trim().toLowerCase() === "current location";
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

function sameCoordinate(pointA, pointB) {
  if (!pointA || !pointB) return false;
  const latA = normaliseNumber(pointA.latitude);
  const lngA = normaliseNumber(pointA.longitude);
  const latB = normaliseNumber(pointB.latitude);
  const lngB = normaliseNumber(pointB.longitude);
  if (latA === null || lngA === null || latB === null || lngB === null) return false;
  return Math.abs(latA - latB) < 0.0001 && Math.abs(lngA - lngB) < 0.0001;
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

function buildGoogleMapsRouteUrl(origin, destination, waypoints = [], useLiveCurrentLocation = false) {
  const destinationText = buildCoordinateText(destination);

  if (!destinationText) {
    return "";
  }

  const params = new URLSearchParams();

  params.set("api", "1");

  if (!useLiveCurrentLocation) {
    const originText = buildCoordinateText(origin);

    if (!originText) {
      return "";
    }

    params.set("origin", originText);
  }

  params.set("destination", destinationText);
  params.set("travelmode", "driving");

  const waypointTexts = waypoints
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
  const startLat = normaliseNumber(itinerary.start_latitude);
  const startLng = normaliseNumber(itinerary.start_longitude);
  const endLat = normaliseNumber(itinerary.end_latitude);
  const endLng = normaliseNumber(itinerary.end_longitude);

  const useLiveCurrentLocation = isCurrentLocationName(
    itinerary.start_location_name
  );

  const startPoint = {
    latitude: startLat,
    longitude: startLng
  };

  const validStopPoints = stops
    .map(function (stop) {
      const lat = normaliseNumber(stop.latitude);
      const lng = normaliseNumber(stop.longitude);

      if (lat === null || lng === null) {
        return null;
      }

      return {
        latitude: lat,
        longitude: lng
      };
    })
    .filter(Boolean);

  const endPoint = validStopPoints.length
    ? validStopPoints[validStopPoints.length - 1]
    : endLat !== null && endLng !== null
      ? { latitude: endLat, longitude: endLng }
      : null;

  if (!endPoint) {
    return "";
  }

  const waypointPoints = validStopPoints.slice(0, -1);

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

    console.log("[Saved Detail] direct document found:", data);

    if (data.user_id !== user.uid && data.status !== "Published") {
      console.warn("[Saved Detail] permission mismatch:", {
        documentUserId: data.user_id,
        currentUserId: user.uid,
        status: data.status
      });

      return null;
    }

    return {
      ...data,
      document_id: directDocSnap.id,
      itinerary_id: data.itinerary_id || directDocSnap.id
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

  console.log("[Saved Detail] fallback document found:", data);

  if (data.user_id !== user.uid && data.status !== "Published") {
    console.warn("[Saved Detail] permission mismatch:", {
      documentUserId: data.user_id,
      currentUserId: user.uid,
      status: data.status
    });

    return null;
  }

  return {
    ...data,
    document_id: docSnap.id,
    itinerary_id: data.itinerary_id || docSnap.id
  };
}

async function getItineraryStops(targetItineraryId) {
  const stopsQuery = query(
    collection(db, ITINERARY_STOP_COLLECTION),
    where("itinerary_id", "==", targetItineraryId)
  );

  const snapshot = await getDocs(stopsQuery);

  const stops = [];

  snapshot.forEach(function (docSnap) {
    stops.push({
      document_id: docSnap.id,
      ...docSnap.data()
    });
  });

  stops.sort(function (a, b) {
    return Number(a.stop_order || 0) - Number(b.stop_order || 0);
  });

  return stops;
}

async function loadDetail(user) {
  const itinerary = await getItinerary(user);

  if (!itinerary) {
    showError();
    return;
  }

  const targetItineraryId =
    itinerary.itinerary_id ||
    itinerary.document_id;

  const stops = (await getItineraryStops(targetItineraryId)).filter(isUsableStop);

  renderItinerary(itinerary, stops);
  renderStops(itinerary, stops);

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
  const stopCount = stops.length;

  const startName = itinerary.start_location_name || "Start Location";
  const endName = itinerary.end_location_name || itinerary.destination || "End Location";
  const routeName = `${startName} to ${endName}`;

  setText("detail-title", itinerary.title || "Untitled Trip");
  setText("detail-destination", routeName);
  setText("detail-date", formatDate(itinerary.travel_date));
  setText("detail-start", startName);
  setText("detail-end", endName);
  setText("detail-hours", itinerary.available_hours ? `${itinerary.available_hours} hrs` : "Estimated");
  setText("detail-interest", itinerary.interest || "-");
  setText("detail-stop-count", `${stopCount} stops`);
  setText("detail-travel-duration", formatMinutes(itinerary.travel_duration_minutes));

  updateStatusBadge(itinerary.status || "Draft");

  const useLiveCurrentLocation = isCurrentLocationName(
    itinerary.start_location_name
  );

  const fullRouteUrl = buildFallbackFullRouteUrl(itinerary, stops);

  renderFullGoogleRouteAction(fullRouteUrl);
}

function renderFullGoogleRouteAction(url) {
  const action = document.getElementById("detail-full-route-action");
  const link = document.getElementById("detail-google-full-route-link");

  if (!action || !link) return;

  if (!url) {
    action.style.display = "none";
    link.removeAttribute("href");
    return;
  }

  link.href = url;
  action.style.display = "flex";
}

function renderStops(itinerary, stops) {
  const stopList = document.getElementById("detail-stop-list");

  if (!stopList) return;

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

  stopList.innerHTML = "";

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

    if (index === 0) {
      originPoint = {
        latitude: itinerary.start_latitude,
        longitude: itinerary.start_longitude
      };

      useLiveCurrentLocation = isCurrentLocationName(
        itinerary.start_location_name
      );
    } else {
      originPoint = {
        latitude: stops[index - 1].latitude,
        longitude: stops[index - 1].longitude
      };
    }

    const destinationPoint = {
      latitude: stop.latitude,
      longitude: stop.longitude
    };

    const googleMapsUrl = buildGoogleMapsUrl(
      originPoint,
      destinationPoint,
      useLiveCurrentLocation
    );

    const googleMapsLabel =
      index === 0 && useLiveCurrentLocation
        ? `Google Maps: Current Location → ${stop.stop_name || "Stop"}`
        : stop.google_maps_label || `Google Maps: Previous Stop → ${stop.stop_name || "Stop"}`;

    const googleMapsButton = googleMapsUrl
      ? `
        <div class="detail-stop-actions">
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

  const startLat = normaliseNumber(itinerary.start_latitude);
  const startLng = normaliseNumber(itinerary.start_longitude);
  const endLat = normaliseNumber(itinerary.end_latitude);
  const endLng = normaliseNumber(itinerary.end_longitude);

  const mapPoints = [];

  if (startLat !== null && startLng !== null) {
    mapPoints.push({
      label: `Start: ${itinerary.start_location_name || "Start Location"}`,
      latitude: startLat,
      longitude: startLng
    });
  }

  stops.forEach(function (stop, index) {
    const lat = normaliseNumber(stop.latitude);
    const lng = normaliseNumber(stop.longitude);

    if (lat !== null && lng !== null) {
      mapPoints.push({
        label: `${index + 1}. ${stop.stop_name || "Stop"}`,
        latitude: lat,
        longitude: lng
      });
    }
  });

  const endPoint = endLat !== null && endLng !== null
    ? {
      label: `End: ${itinerary.end_location_name || "End Location"}`,
      latitude: endLat,
      longitude: endLng
    }
    : null;

  if (endPoint && !stops.length && !sameCoordinate(mapPoints[mapPoints.length - 1], endPoint)) {
    mapPoints.push(endPoint);
  }

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

  let routeLayer = null;

  if (mapPoints.length >= 2) {
    const roadRouteGeometry = await getRoadRouteGeometry(mapPoints);

    if (roadRouteGeometry) {
      routeLayer = L.geoJSON(roadRouteGeometry).addTo(detailMap);
    } else {
      const polylinePoints = mapPoints.map(function (point) {
        return [point.latitude, point.longitude];
      });

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
