// Smart Itinerary Page

function getStopLimitByHours(hours) {
  const parsedHours = parseInt(hours || "6", 10);
  return Math.max(1, Math.min(parsedHours - 3, 6));
}

function updateMaximumStopsOptions() {
  const availableHoursSelect = document.getElementById("available_hours");
  const maxStopsSelect = document.getElementById("max_stops");

  if (!availableHoursSelect || !maxStopsSelect) return;

  const stopLimit = getStopLimitByHours(availableHoursSelect.value);
  const currentValue = parseInt(
    maxStopsSelect.value || maxStopsSelect.dataset.selected || "3",
    10
  );

  const nextValue = Math.min(Math.max(currentValue, 1), stopLimit);

  maxStopsSelect.innerHTML = "";

  for (let stop = 1; stop <= stopLimit; stop += 1) {
    const option = document.createElement("option");

    option.value = String(stop);
    option.textContent = stop + (stop > 1 ? " stops" : " stop");

    if (stop === nextValue) {
      option.selected = true;
    }

    maxStopsSelect.appendChild(option);
  }
}

function initRouteMap() {
  const mapDataElement = document.getElementById("map-data");
  const routeMapElement = document.getElementById("routeMap");

  if (!mapDataElement || !routeMapElement) return;
  if (typeof L === "undefined") return;

  const mapData = JSON.parse(mapDataElement.textContent);

  const startPoint = mapData.start;
  const endPoint = mapData.end;
  const attractions = mapData.attractions || [];
  const routeGeometry = mapData.routeGeometry;

  if (!startPoint || !endPoint) return;

  const map = L.map("routeMap").setView(
    [startPoint.latitude, startPoint.longitude],
    13
  );

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const markerGroup = L.featureGroup();

  const startMarker = L.marker([startPoint.latitude, startPoint.longitude])
    .bindPopup("Start: " + mapData.startText)
    .addTo(map);

  markerGroup.addLayer(startMarker);

  attractions.forEach((place, index) => {
    const marker = L.marker([place.latitude, place.longitude])
      .bindPopup((index + 1) + ". " + place.name)
      .addTo(map);

    markerGroup.addLayer(marker);
  });

  const endMarker = L.marker([endPoint.latitude, endPoint.longitude])
    .bindPopup("End: " + mapData.endText)
    .addTo(map);

  markerGroup.addLayer(endMarker);

  if (routeGeometry) {
    const routeLayer = L.geoJSON(routeGeometry).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [24, 24] });
  } else {
    map.fitBounds(markerGroup.getBounds(), { padding: [24, 24] });
  }
}

document.addEventListener("DOMContentLoaded", function () {
  updateMaximumStopsOptions();

  const availableHoursSelect = document.getElementById("available_hours");

  if (availableHoursSelect) {
    availableHoursSelect.addEventListener("change", updateMaximumStopsOptions);
  }

  initRouteMap();
});