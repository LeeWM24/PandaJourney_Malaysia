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
  const stopCount =
    itinerary.stop_count ||
    stops.length ||
    0;

  setText("detail-title", itinerary.title || "Untitled Trip");
  setText("detail-destination", itinerary.destination || "Malaysia");
  setText("detail-date", formatDate(itinerary.travel_date));
  setText("detail-start", getStartLocationName(itinerary));
  setText("detail-end", getEndLocationName(itinerary));
  setText("detail-hours", itinerary.available_hours ? `${itinerary.available_hours} hrs` : "Estimated");

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
        : getStartLocationName(itinerary);
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
      label: `Start: ${getStartLocationName(itinerary)}`,
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
      label: `End: ${getEndLocationName(itinerary)}`,
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
