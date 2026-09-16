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
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const FAVOURITES_COLLECTION = "Favourites";
const FAVOURITES_CACHE_PREFIX = "pandajourney:favourites:";

function readJsonData(elementId, fallback) {
  const el = document.getElementById(elementId);
  if (!el) return fallback;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return fallback;
  }
}

let attractionsData = readJsonData('attraction-data', []);

const searchState = readJsonData('search-state', {
  searched: false,
  filters: { destination: '', interests: [], min_rating: '0', weather_aware: false },
});
const googleMapsConfig = readJsonData('google-maps-config', { enabled: false });

const favourites = new Set();

const favouriteDocIds = new Map();
const ATTRACTION_SESSION_KEY = 'pandajourney:smart-attraction-state:v1';
let currentUser = null;
let hasSearched = !!searchState.searched;
let appliedFilters = {
  dest: searchState.filters.destination || '',
  interests: searchState.filters.interests || [],
  minRating: searchState.filters.min_rating || '0',
  weather: !!searchState.filters.weather_aware,
};
let currentAttr = null;
let toastTimer = null;

function attractionIdentity(attraction = {}) {
  if (attraction.place_id) return `place:${attraction.place_id}`;
  const latitude = Number(attraction.latitude);
  const longitude = Number(attraction.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return `geo:${latitude.toFixed(5)}:${longitude.toFixed(5)}`;
  }
  return `name:${String(attraction.name || '').trim().toLowerCase()}:${String(attraction.location || attraction.area || '').trim().toLowerCase()}`;
}

function favouriteIdentity(data = {}) {
  return data.attraction_key || attractionIdentity(data);
}

function favouritesCacheKey(user) {
  return `${FAVOURITES_CACHE_PREFIX}${user.uid}`;
}

function restoreFavouritesFromLocalStorage(user) {
  try {
    const cached = JSON.parse(localStorage.getItem(favouritesCacheKey(user)) || "[]");
    if (!Array.isArray(cached)) return;

    favourites.clear();
    favouriteDocIds.clear();

    cached.forEach((item) => {
      if (!item || (!item.key && !item.name)) return;
      const key = item.key || `name:${String(item.name).trim().toLowerCase()}:`;
      const match = attractionsData.find((attraction) => attractionIdentity(attraction) === key)
        || attractionsData.find((attraction) => attraction.name === item.name);
      const resolvedKey = match ? attractionIdentity(match) : key;
      if (item.docId) favouriteDocIds.set(resolvedKey, item.docId);
      if (match) favourites.add(match.id);
    });
  } catch {
    localStorage.removeItem(favouritesCacheKey(user));
  }
}

function saveFavouritesToLocalStorage(user) {
  if (!user) return;

  const payload = Array.from(favouriteDocIds.entries()).map(([key, docId]) => ({
    key,
    name: attractionsData.find((item) => attractionIdentity(item) === key)?.name || '',
    docId,
  }));

  try {
    localStorage.setItem(favouritesCacheKey(user), JSON.stringify(payload));
  } catch {
    // Ignore quota/private-mode failures; Firestore remains source of truth.
  }
}

// Pagination: render only PAGE_SIZE cards for the current page, with real
// page-number navigation (rather than a cumulative "show more" list).
const PAGE_SIZE = 6;
let currentPage = 1;

function saveAttractionSessionState() {
  const sortSelect = document.getElementById('sort-select');
  const latitudeInput = document.getElementById('destination_lat');
  const longitudeInput = document.getElementById('destination_lng');
  try {
    sessionStorage.setItem(ATTRACTION_SESSION_KEY, JSON.stringify({
      attractions: attractionsData,
      searched: hasSearched,
      filters: appliedFilters,
      sort: sortSelect ? sortSelect.value : (searchState.filters.sort || 'score'),
      page: currentPage,
      destinationLat: latitudeInput ? latitudeInput.value : '',
      destinationLng: longitudeInput ? longitudeInput.value : '',
    }));
  } catch {
    // A large result set can exceed private-mode or storage limits.
  }
}

function restoreAttractionSessionState() {
  if (searchState.submitted) return false;

  try {
    const cached = JSON.parse(sessionStorage.getItem(ATTRACTION_SESSION_KEY) || 'null');
    if (!cached || !Array.isArray(cached.attractions) || !cached.filters) return false;

    attractionsData = cached.attractions;
    hasSearched = !!cached.searched;
    appliedFilters = {
      dest: cached.filters.dest || '',
      interests: Array.isArray(cached.filters.interests) ? cached.filters.interests : [],
      minRating: cached.filters.minRating || '0',
      weather: !!cached.filters.weather,
    };
    currentPage = Math.max(1, Number(cached.page) || 1);

    const destination = document.getElementById('destination');
    const rating = document.getElementById('filter-rating');
    const weather = document.getElementById('weather_aware');
    const sort = document.getElementById('sort-select');
    const latitude = document.getElementById('destination_lat');
    const longitude = document.getElementById('destination_lng');
    if (destination) destination.value = appliedFilters.dest;
    if (rating) rating.value = appliedFilters.minRating;
    if (weather) weather.checked = appliedFilters.weather;
    if (sort) sort.value = cached.sort || 'score';
    if (latitude) latitude.value = cached.destinationLat || '';
    if (longitude) longitude.value = cached.destinationLng || '';
    document.querySelectorAll('input[name="interests"]').forEach((input) => {
      input.checked = appliedFilters.interests.includes(input.value);
    });
    return true;
  } catch {
    sessionStorage.removeItem(ATTRACTION_SESSION_KEY);
    return false;
  }
}

function resetPagination() {
  currentPage = 1;
}

document.addEventListener('DOMContentLoaded', () => {
  showLoadingOverlay('Loading attraction page...', 'Preparing recommendations and filters.');
  restoreAttractionSessionState();
  initializeChipState();
  bindFilterEvents();
  bindPanelEvents();
  renderCards();
  updateFavUI();
  bindSearchLoadingOverlay();
  bindDestinationSuggestions();
  bindCurrentLocation();
  saveAttractionSessionState();
  window.addEventListener('pagehide', saveAttractionSessionState);
  window.setTimeout(hideLoadingOverlay, 450);

  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn && hasSearched) {
    clearBtn.removeAttribute('hidden');
    clearBtn.style.display = '';
  }
});

// Shows the loading overlay the instant the search form is submitted.
// This is a normal full-page form POST (not AJAX), so the overlay just
// stays up until the new page finishes loading — no need to hide it.
function bindSearchLoadingOverlay() {
  const form = document.getElementById('filter-form');
  const tokenInput = document.getElementById('firebase-id-token');
  if (!form) return;

  let submissionPending = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (submissionPending) return;
    submissionPending = true;

    showLoadingOverlay(
      'Searching attractions...',
      'Checking cached results and nearby places. This can take a few seconds.'
    );

    try {
      if (tokenInput) {
        tokenInput.value = currentUser
          ? await currentUser.getIdToken()
          : '';
      }

      form.submit();
    } catch (error) {
      submissionPending = false;
      hideLoadingOverlay();
      console.error('Unable to prepare attraction search:', error);
      showToast('Unable to verify your session. Please try again.', 'error');
    }
  });
}

function showLoadingOverlay(title, subtext) {
  const overlay = document.getElementById('planner-loading-overlay');
  if (!overlay) return;
  const titleEl = overlay.querySelector('.planner-loading-title');
  const subEl = overlay.querySelector('.planner-loading-sub');
  if (titleEl && title) titleEl.textContent = title;
  if (subEl && subtext) subEl.textContent = subtext;
  overlay.style.display = 'flex';
  overlay.setAttribute('aria-hidden', 'false');
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('planner-loading-overlay');
  if (!overlay) return;
  overlay.style.display = 'none';
  overlay.setAttribute('aria-hidden', 'true');
}

// Custom "Google Maps style" type-ahead for the destination field, used
// only when no Google Places key is configured. Debounces keystrokes, hits our
// own /smart-attraction/suggest endpoint (backed by cached Nominatim
// results), and fills the same hidden lat/lng inputs Google's widget uses
// — so the backend doesn't need to know which source picked the place.
function bindDestinationSuggestions() {
  if (googleMapsConfig.enabled) return; // Google's own widget handles this instead

  const input = document.getElementById('destination');
  const latInput = document.getElementById('destination_lat');
  const lngInput = document.getElementById('destination_lng');
  const dropdown = document.getElementById('destination-suggestions');
  if (!input || !dropdown) return;

  let debounceTimer = null;
  let activeIndex = -1;
  let currentItems = [];

  function closeDropdown() {
    dropdown.classList.remove('show');
    dropdown.innerHTML = '';
    activeIndex = -1;
    currentItems = [];
  }

  function selectItem(item) {
    // Fill the box with just the clean name — the full address (still
    // used for the fallback geocode path) stays behind the scenes.
    input.value = item.name || item.display_name;
    if (latInput) latInput.value = item.latitude;
    if (lngInput) lngInput.value = item.longitude;
    closeDropdown();
  }

  function renderItems(items) {
    currentItems = items;
    activeIndex = -1;

    if (!items.length) {
      dropdown.innerHTML = '<div class="destination-suggestion-empty" role="status"></div>';
      dropdown.firstElementChild.textContent = `No destinations found for "${input.value.trim()}".`;
      dropdown.classList.add('show');
      return;
    }

    dropdown.innerHTML = items.map((item, index) => `
      <div class="destination-suggestion-item" role="option" data-index="${index}">
        📍
        <span>
          <span class="destination-suggestion-name">${item.name || item.display_name}</span>
        </span>
      </div>`).join('');

    dropdown.classList.add('show');

    dropdown.querySelectorAll('.destination-suggestion-item').forEach((el) => {
      el.addEventListener('mousedown', (event) => {
        // mousedown (not click) fires before the input's blur event closes the dropdown
        event.preventDefault();
        selectItem(currentItems[Number(el.dataset.index)]);
      });
    });
  }

  async function fetchSuggestions(query) {
    try {
      const response = await fetch(`/smart-attraction/suggest?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error('Suggestion request failed');
      const items = await response.json();
      renderItems(Array.isArray(items) ? items : []);
    } catch (error) {
      closeDropdown();
    }
  }

  input.addEventListener('input', () => {
    // Typing invalidates any previously selected lat/lng — force the
    // backend to (re)geocode whatever text ends up submitted.
    if (latInput) latInput.value = '';
    if (lngInput) lngInput.value = '';

    const query = input.value.trim();
    clearTimeout(debounceTimer);

    if (query.length < 1) {
      closeDropdown();
      return;
    }

    debounceTimer = setTimeout(() => fetchSuggestions(query), 300);
  });

  input.addEventListener('keydown', (event) => {
    if (!dropdown.classList.contains('show')) return;
    const items = dropdown.querySelectorAll('.destination-suggestion-item');
    if (!items.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (event.key === 'Enter') {
      if (activeIndex >= 0) {
        event.preventDefault();
        selectItem(currentItems[activeIndex]);
      }
      return;
    } else if (event.key === 'Escape') {
      closeDropdown();
      return;
    } else {
      return;
    }

    items.forEach((el, idx) => el.classList.toggle('active', idx === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  });

  input.addEventListener('blur', () => {
    // Slight delay so a mousedown-based selection (above) can still fire first.
    setTimeout(closeDropdown, 120);
  });

  document.addEventListener('click', (event) => {
    if (event.target !== input && !dropdown.contains(event.target)) {
      closeDropdown();
    }
  });
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;

  if (user) {
    restoreFavouritesFromLocalStorage(user);
    renderCards();
    updateFavUI();
    loadFavourites(user);
  } else {
    favourites.clear();
    favouriteDocIds.clear();
    renderCards();
    updateFavUI();
  }
});

async function loadFavourites(user) {
  try {
    const favouritesQuery = query(
      collection(db, FAVOURITES_COLLECTION),
      where('user_id', '==', user.uid)
    );

    const snapshot = await getDocs(favouritesQuery);

    favourites.clear();
    favouriteDocIds.clear();

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const key = favouriteIdentity(data);
      const match = attractionsData.find((item) => attractionIdentity(item) === key)
        || attractionsData.find((item) => item.name === data.name);
      favouriteDocIds.set(match ? attractionIdentity(match) : key, docSnap.id);
      if (match) favourites.add(match.id);
    });

    saveFavouritesToLocalStorage(user);
    renderCards();
    updateFavUI();
  } catch (error) {
    console.error('Failed to load favourites:', error);
  }
}

function initializeChipState() {
  document.querySelectorAll('.chip[data-chip]').forEach((chip) => {
    const checkbox = chip.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    chip.classList.toggle('active', checkbox.checked);
    // update class when checkbox value changes
    checkbox.addEventListener('change', () => {
      chip.classList.toggle('active', checkbox.checked);
    });
    // also allow clicking the chip container to toggle
    chip.addEventListener('click', (ev) => {
      // ignore if click was on a real focusable element
      if (ev.target.tagName.toLowerCase() === 'input') return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// Leaflet (OpenStreetMap) integration

let _map = null;
let _marker = null;

function createMap() {
  try {
    if (!_map && typeof L !== 'undefined') {
      const el = document.getElementById('detail-map');
      _map = L.map(el, { center: [3.139, 101.6869], zoom: 12, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(_map);
      _map.on('click', openCurrentAttractionInOpenStreetMap);
    }
    return _map;
  } catch (e) {
    console.warn('createMap error:', e);
    return null;
  }
}

function updateMapForAttraction(attraction) {
  if (!attraction) return;
  const lat = Number(attraction.latitude || attraction.lat || attraction.latitude_deg || 0);
  const lng = Number(attraction.longitude || attraction.lon || attraction.lng || 0);

  const linkEl = document.getElementById('detail-map-link');
  const mapEl = document.getElementById('detail-map');
  const openStreetMapUrl = getOpenStreetMapUrl(attraction);
  if (mapEl) {
    mapEl.dataset.mapsUrl = openStreetMapUrl;
    mapEl.setAttribute('role', 'link');
    mapEl.setAttribute('tabindex', '0');
    mapEl.setAttribute('aria-label', 'Open this attraction in OpenStreetMap');
    mapEl.title = 'Click to open in OpenStreetMap';
  }

  if (!lat || !lng) {
    if (linkEl) linkEl.style.display = 'none';
    return;
  }

  // Delay to ensure the detail panel is fully visible before initializing the map
  setTimeout(() => {
    const map = createMap();
    if (!map) return;

    try {
      // Ensure the map knows its container size (fixes cropped/partial tiles)
      map.invalidateSize();
    } catch (e) { console.warn('invalidateSize error:', e); }

    const pos = [lat, lng];
    map.setView(pos, 15);

    // Remove old marker if it exists
    if (_marker) {
      try {
        map.removeLayer(_marker);
        _marker = null;
      } catch (e) { console.warn('removeLayer error:', e); }
    }

    // Create and add new marker
    try {
      _marker = L.marker(pos)
        .addTo(map)
        .bindPopup(attraction.name || 'Attraction')
        .openPopup();
    } catch (e) { console.warn('marker creation error:', e); }

    // Keep a hidden fallback link current; the map itself is the click target.
    if (linkEl) {
      linkEl.href = openStreetMapUrl;
      linkEl.textContent = 'Open in OpenStreetMap';
      linkEl.style.display = 'none';
    }
  }, 150);
}

function bindFilterEvents() {

  document.getElementById('sort-select').addEventListener('change', () => {
    resetPagination();
    renderCards();
    saveAttractionSessionState();
  });
  const clearFiltersButton = document.getElementById('clear-filters');
  if (clearFiltersButton) clearFiltersButton.addEventListener('click', clearFilters);
}

function bindPanelEvents() {
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-close-btn').addEventListener('click', closeDetail);
  document.getElementById('detail-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeDetail();
  });
  document.getElementById('detail-fav-btn').addEventListener('click', () => {
    const id = Number(document.getElementById('detail-fav-btn').dataset.favId);
    if (!Number.isNaN(id)) toggleFavourite(id);
  });
  document.getElementById('detail-start-btn').addEventListener('click', addCurrentAttractionAsStart);
  const detailMap = document.getElementById('detail-map');
  if (detailMap) {
    detailMap.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openCurrentAttractionInOpenStreetMap();
      }
    });
  }
}

// Return an OpenStreetMap URL matching the detail panel's embedded map.
function getOpenStreetMapUrl(attraction) {
  if (!attraction) return '';
  const lat = Number(attraction.latitude || attraction.lat || attraction.latitude_deg || 0);
  const lng = Number(attraction.longitude || attraction.lon || attraction.lng || 0);
  if (lat && lng) {
    return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}#map=17/${lat}/${lng}`;
  }
  const query = `${attraction.name || ''} ${attraction.area || attraction.location || ''}`.trim();
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

function openCurrentAttractionInOpenStreetMap() {
  const url = getOpenStreetMapUrl(currentAttr);
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function getGoogleReviewsUrl(attraction) {
  if (!attraction) return '';
  const providerReviewsUrl = String(attraction.reviews_link || '').trim();
  if (/^https:\/\/(www\.)?google\.[^/]+\//i.test(providerReviewsUrl)) {
    return providerReviewsUrl;
  }

  const googlePlaceId = String(attraction.google_place_id || attraction.place_id || '').trim();
  // SerpAPI data IDs look like "0x...:0x..." and are not Google Place IDs.
  if (googlePlaceId && !googlePlaceId.includes(':')) {
    return `https://search.google.com/local/reviews?placeid=${encodeURIComponent(googlePlaceId)}`;
  }

  const query = [
    attraction.name,
    attraction.area || attraction.location,
    'Google reviews'
  ].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function bindCurrentLocation() {
  const button = document.getElementById('use-current-location');
  const input = document.getElementById('destination');
  const latInput = document.getElementById('destination_lat');
  const lngInput = document.getElementById('destination_lng');
  if (!button || !input || !latInput || !lngInput) return;

  button.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Current location is not supported by this browser.');
      return;
    }
    button.disabled = true;
    button.textContent = 'Finding your location...';
    navigator.geolocation.getCurrentPosition((position) => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      if (latitude < 0.7 || latitude > 7.6 || longitude < 99.5 || longitude > 120.5) {
        showToast('Your current location is outside Malaysia.');
      } else {
        input.value = 'Current location';
        latInput.value = String(latitude);
        lngInput.value = String(longitude);
        showToast('Current location selected.');
      }
      button.disabled = false;
      button.textContent = 'Use my current location';
    }, () => {
      button.disabled = false;
      button.textContent = 'Use my current location';
      showToast('Location permission was unavailable. You can still type a destination.');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });
}

function addCurrentAttractionAsStart() {
  if (!currentAttr) return;

  saveAttractionSessionState();
  const params = new URLSearchParams({
    start: currentAttr.name || 'Attraction',
  });
  if (currentAttr.latitude !== null && currentAttr.latitude !== undefined) {
    params.set('start_latitude', currentAttr.latitude);
  }
  if (currentAttr.longitude !== null && currentAttr.longitude !== undefined) {
    params.set('start_longitude', currentAttr.longitude);
  }
  window.location.href = `/smart-itinerary?${params.toString()}`;
}

function safeWebsiteUrl(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '';
  try {
    const url = new URL(rawValue.startsWith('www.') ? `https://${rawValue}` : rawValue);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function clearFilters() {
  sessionStorage.removeItem(ATTRACTION_SESSION_KEY);
  window.location.href = window.location.pathname;
}

const RATING_MIN = { '0': 0, '3.0': 3, '4.0': 4, '4.5': 4.5 };

function getFilteredAttractions() {
  if (!hasSearched) return [];
  return attractionsData.filter((item) => {
    if (appliedFilters.interests.length > 0) {
      // match when the attraction has any of the selected interests (OR logic)
      const itemInterestsRaw = item.interests || item.interest_tags || item.tags || [];
      const itemInterests = (Array.isArray(itemInterestsRaw) ? itemInterestsRaw : [itemInterestsRaw]).map(x => String(x).toLowerCase());
      const selected = appliedFilters.interests.map(x => String(x).toLowerCase());
      const matchesInterest = selected.some((interest) => itemInterests.includes(interest));
      if (!matchesInterest) return false;
    }
    const minimum = RATING_MIN[appliedFilters.minRating] || 0;
    if (minimum && Number(item.rating) < minimum) return false;
    return true;
  });
}

function getSortedAttractions(list) {
  const mode = document.getElementById('sort-select').value;
  return [...list].sort((a, b) => {
    // A selected venue is the user's explicit destination, so keep it first
    // for relevance and distance sorting when Google Maps returns it.
    if (mode === 'score' || mode === 'nearest') {
      const destinationDifference = Number(!!b.is_destination_match) - Number(!!a.is_destination_match);
      if (destinationDifference) return destinationDifference;
    }
    if (mode === 'rating') return Number(b.rating || 0) - Number(a.rating || 0);
    if (mode === 'rating-asc') return Number(a.rating || 0) - Number(b.rating || 0);
    if (mode === 'nearest') return Number(a.distance_km ?? Infinity) - Number(b.distance_km ?? Infinity);
    return Number(b.relevance_score ?? b.score ?? 0) - Number(a.relevance_score ?? a.score ?? 0);
  });
}

function renderCards() {
  const filtered = getFilteredAttractions();
  const sorted = getSortedAttractions(filtered);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const visible = sorted.slice(startIndex, startIndex + PAGE_SIZE);
  const grid = document.getElementById('cards-grid');
  const countEl = document.getElementById('results-count');
  const noteEl = document.getElementById('results-note');
  const weatherEl = document.getElementById('weather-note');
  const paginationWrap = document.getElementById('pagination-wrap');

  if (!hasSearched) {
    countEl.innerHTML = 'Showing <strong>0</strong> attractions';
    noteEl.textContent = 'Choose your filters, then click Search Attractions to view recommendations.';
    weatherEl.style.display = 'none';
    weatherEl.textContent = '';
    grid.innerHTML = '';
    if (paginationWrap) {
      paginationWrap.style.display = 'none';
      paginationWrap.innerHTML = '';
    }
    return;
  }

  const label = hasSearched ? `result${sorted.length !== 1 ? 's' : ''}` : 'attractions';
  countEl.innerHTML = `Showing <strong>${visible.length}</strong> of <strong>${sorted.length}</strong> ${label}`;
  if (!hasSearched) {
    noteEl.textContent = 'Showing all attractions — apply filters to refine results.';
  } else if (sorted.length === 0) {
    noteEl.textContent = 'No attractions matched your selections. Try relaxing one filter.';
  } else {
    noteEl.textContent = `Found ${sorted.length} attraction${sorted.length !== 1 ? 's' : ''} that match your filters.`;
  }

  weatherEl.style.display = 'none';
  weatherEl.textContent = '';

  if (sorted.length === 0) {
    if (paginationWrap) paginationWrap.style.display = 'none';
    if (!hasSearched) {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = `
      <div class="card card-p" style="grid-column: 1 / -1;">
        <div class="empty-state">
          <div class="empty-icon">🌴</div>
          <div class="empty-title">No attractions found</div>
          <div class="empty-desc">${Number(appliedFilters.minRating || 0) > 0 ? 'Try lowering the minimum rating, removing an interest, or choosing a nearby destination.' : 'Try a different destination or remove an interest.'}</div>
        </div>
      </div>`;
    return;
  }

  grid.innerHTML = visible.map((attraction) => buildCard(attraction)).join('');
  updateCardFavourites();
  renderPagination(totalPages, paginationWrap);
}

// Builds Prev / page-number / Next controls — 6 attractions per page,
// jump straight to any page instead of accumulating a longer list.
function renderPagination(totalPages, paginationWrap) {
  if (!paginationWrap) return;

  if (totalPages <= 1) {
    paginationWrap.style.display = 'none';
    paginationWrap.innerHTML = '';
    return;
  }

  paginationWrap.style.display = 'flex';

  const pageButton = (page, label, opts = {}) => `
    <button type="button" class="page-btn ${opts.active ? 'active' : ''}"
      data-page="${page}" ${opts.disabled ? 'disabled' : ''}>${label}</button>`;

  let buttons = pageButton(currentPage - 1, '‹', { disabled: currentPage === 1 });

  // Simple windowed page numbers: first, last, and a few around current.
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  let lastRendered = 0;

  for (let page = 1; page <= totalPages; page += 1) {
    if (!pages.has(page)) continue;
    if (page - lastRendered > 1) {
      buttons += `<span class="page-btn" style="border:none;background:none;cursor:default;">…</span>`;
    }
    buttons += pageButton(page, String(page), { active: page === currentPage });
    lastRendered = page;
  }

  buttons += pageButton(currentPage + 1, '›', { disabled: currentPage === totalPages });

  paginationWrap.innerHTML = buttons;

  paginationWrap.querySelectorAll('.page-btn[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = Number(btn.dataset.page);
      if (!page || page < 1 || page > totalPages || page === currentPage) return;
      currentPage = page;
      renderCards();
      saveAttractionSessionState();
      document.getElementById('cards-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// Real-time weather icon lookup — condition strings come from the backend's
// Open-Meteo WMO code mapping, so this matches on keywords rather than a
// fixed set of exact strings.
function weatherIcon(condition) {
  const text = String(condition || '').toLowerCase();
  if (text.includes('thunder')) return '⛈️';
  if (text.includes('rain') || text.includes('drizzle')) return '🌧️';
  if (text.includes('fog')) return '🌫️';
  if (text.includes('overcast')) return '☁️';
  if (text.includes('partly')) return '⛅';
  if (text.includes('clear') || text.includes('sunny') || text.includes('mainly clear')) return '☀️';
  return '🌡️';
}

function buildWeatherBadgeHtml(attraction) {
  if (!appliedFilters.weather) return '';
  const weather = attraction.current_weather;
  if (weather && weather.condition) {
    const temp = weather.temp !== null && weather.temp !== undefined ? `${Math.round(weather.temp)}°C` : '';
    return `<span class="badge badge-warning">${weatherIcon(weather.condition)} ${weather.condition}${temp ? ' · ' + temp : ''}</span>`;
  }
  if (attraction.weather_suitability === 'Indoor') {
    return '<span class="badge badge-info">🏛️ Indoor</span>';
  }
  return '';
}

// Fallback image used whenever SerpAPI doesn't return a photo, or a photo
// URL 404s — avoids the "broken image icon + overflowing alt text" look.
const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">' +
    '<rect width="400" height="300" fill="#e2e8f0"/>' +
    '<text x="50%" y="50%" font-size="70" text-anchor="middle" dominant-baseline="central">🏞️</text>' +
    '</svg>'
  );

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildPlaceholderImage(attraction = {}) {
  const category = String(attraction.category || '').toLowerCase();
  const palette = {
    culture: ['#f8e7c9', '#b45309', '#fff7ed'],
    museum: ['#e0f2fe', '#0369a1', '#f0f9ff'],
    nature: ['#dcfce7', '#15803d', '#f0fdf4'],
    shopping: ['#fae8ff', '#a21caf', '#fdf4ff'],
    food: ['#fee2e2', '#b91c1c', '#fff7ed'],
    adventure: ['#ffedd5', '#c2410c', '#fff7ed'],
  };
  const colors = palette[String(category).toLowerCase()] || ['#dbeafe', '#0f766e', '#f8fafc'];

  return 'data:image/svg+xml;utf8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 620">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${colors[0]}"/>
          <stop offset="1" stop-color="${colors[2]}"/>
        </linearGradient>
      </defs>
      <rect width="900" height="620" rx="42" fill="url(#bg)"/>
      <circle cx="760" cy="118" r="110" fill="${colors[1]}" opacity=".16"/>
      <circle cx="135" cy="500" r="155" fill="${colors[1]}" opacity=".10"/>
      <path d="M170 420h560l-92-124-76 83-95-132-104 144-62-74z" fill="${colors[1]}" opacity=".38"/>
      <path d="M150 455h600" stroke="${colors[1]}" stroke-width="18" stroke-linecap="round" opacity=".32"/>
      <circle cx="450" cy="282" r="62" fill="#fff" opacity=".72"/>
      <path d="M421 297l25-28 20 21 18-18 25 25z" fill="${colors[1]}" opacity=".65"/>
    </svg>
  `);
}

function getAttractionImage(attraction = {}) {
  if (attraction.image_url) return attraction.image_url;
  if (Array.isArray(attraction.photo_urls)) {
    const photo = attraction.photo_urls.find(Boolean);
    if (photo) return photo;
  }
  return buildPlaceholderImage(attraction);
}

function buildCard(attraction) {
  const isFav = favourites.has(attraction.id);
  const weatherBadge = buildWeatherBadgeHtml(attraction);
  const imageUrl = getAttractionImage(attraction);
  const fallbackImage = buildPlaceholderImage(attraction);
  const hasProviderImage = attraction.has_provider_photo !== false
    && Boolean(attraction.image_url || (Array.isArray(attraction.photo_urls) && attraction.photo_urls.find(Boolean)));

  const reasons = (attraction.reason_tags || []).map((reason) => `<span class="reason-tag">${reason}</span>`).join('');
  const locationLabel = attraction.location || attraction.area || 'Unknown location';
  const ratingText = attraction.rating ? Number(attraction.rating).toFixed(1) : 'N/A';
  const reviewText = Number(attraction.review_count || 0) > 0
    ? `${Number(attraction.review_count).toLocaleString()} Google reviews`
    : (attraction.rating ? 'Google rating; review count unavailable' : 'Not yet rated');
  const facts = [
    Number(attraction.review_count || 0) > 0 ? `${Number(attraction.review_count).toLocaleString()} reviews` : '',
    attraction.distance_label ? `${attraction.distance_label} straight-line` : '',
    attraction.entry_fee || '',
  ].filter(Boolean);
  const favouriteIcon = currentUser ? (isFav ? '★' : '☆') : '🔒';
  const favouriteTitle = currentUser
    ? (isFav ? 'Remove from favourite' : 'Save to favourite')
    : 'Log in to save this attraction';

  return `
    <article class="attr-card">
      <button class="attr-card-img-wrap ${hasProviderImage ? '' : 'using-fallback'}" type="button" onclick="openDetail(${attraction.id})" aria-label="View details for ${attraction.name}">
        <img src="${imageUrl}" alt="${hasProviderImage ? attraction.name : 'No venue photo available'}" loading="lazy" onerror="this.onerror=null;this.alt='No venue photo available';this.parentElement.classList.add('using-fallback');this.src='${fallbackImage}';" />
        <span class="photo-unavailable">Photo unavailable</span>
        <div class="attr-card-img-overlay"><span class="img-hint">View details</span></div>
        <div class="img-badge-tr">${weatherBadge}</div>
        <div class="img-fav-badge ${isFav ? 'show' : ''}">★</div>
      </button>
      <div class="attr-card-body">
        <div class="attr-card-title-row">
          <div class="attr-card-name">${attraction.name}</div>
          <div class="attr-card-rating" title="${reviewText}">⭐ ${ratingText}</div>
        </div>
        <div class="attr-card-meta">
          <span class="reason-tag" style="background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe;">${attraction.category || ''}</span>
          <span class="attr-card-loc">📍 ${locationLabel}</span>
        </div>
        <div class="attr-card-facts">${facts.map((fact) => `<span>${fact}</span>`).join('<span aria-hidden="true">&bull;</span>')}</div>
        <div class="attr-card-reasons">${reasons}</div>
        <div class="attr-card-actions">
          <button class="btn-view-details" type="button" onclick="openDetail(${attraction.id})">View details</button>
          <button class="btn-fav ${isFav ? 'active' : ''}" id="btn-fav-${attraction.id}" type="button" onclick="toggleFavourite(${attraction.id})" title="${favouriteTitle}">${favouriteIcon}</button>
        </div>
      </div>
    </article>`;
}

function updateCardFavourites() {
  document.querySelectorAll('.btn-fav').forEach((button) => {
    const id = Number(button.id.replace('btn-fav-', ''));
    const isFav = favourites.has(id);
    button.classList.toggle('active', isFav);
    button.textContent = currentUser ? (isFav ? '★' : '☆') : '🔒';
    button.title = currentUser
      ? (isFav ? 'Remove from favourite' : 'Save to favourite')
      : 'Log in to save this attraction';
  });
}

async function toggleFavourite(id) {
  const attraction = attractionsData.find((item) => item.id === id);
  if (!attraction) return;

  if (!currentUser) {
    showToast('Please log in to save favourites.');
    return;
  }

  try {
    const attractionKey = attractionIdentity(attraction);
    const existingDocId = favouriteDocIds.get(attractionKey);

    if (existingDocId) {
      await deleteDoc(doc(db, FAVOURITES_COLLECTION, existingDocId));
      favouriteDocIds.delete(attractionKey);
      favourites.delete(id);
      attraction.is_favourite = false;
      saveFavouritesToLocalStorage(currentUser);
      showToast('Removed from favourite.');
    } else {
      const docRef = await addDoc(collection(db, FAVOURITES_COLLECTION), {
        user_id: currentUser.uid,
        attraction_key: attractionKey,
        place_id: attraction.place_id || '',
        name: attraction.name,
        category: attraction.category || '',
        rating: attraction.rating || 0,
        latitude: attraction.latitude ?? null,
        longitude: attraction.longitude ?? null,
        image_url: attraction.image_url || '',
        area: attraction.area || attraction.location || '',
        waze_url: attraction.waze_url || '',
        created_at: serverTimestamp(),
      });
      favouriteDocIds.set(attractionKey, docRef.id);
      favourites.add(id);
      attraction.is_favourite = true;
      saveFavouritesToLocalStorage(currentUser);
      showToast('Saved to favourite.');
    }

    renderCards();
    updateFavUI();
    syncDetailFavourite(id, favourites.has(id));
  } catch (error) {
    console.error('Failed to update favourites:', error);
    showToast('Could not update favourites — please try again.');
  }
}

function updateFavUI() {
  const count = favourites.size;
  const favChip = document.getElementById('fav-count-chip');
  const favCount = document.getElementById('fav-count');
  const panelChip = document.getElementById('fav-chip');
  if (favChip) favChip.style.display = count > 0 ? 'inline-flex' : 'none';
  if (favCount) favCount.textContent = `${count}`;
  if (panelChip) panelChip.classList.toggle('show', count > 0);
}

function syncDetailFavourite(id, active) {
  const favBtn = document.getElementById('detail-fav-btn');
  if (!favBtn) return;
  favBtn.textContent = !currentUser ? 'Log in to save' : (active ? '★ Saved to favourite' : 'Save to favourite');
  favBtn.classList.toggle('saved', active);
  favBtn.dataset.favId = id;
}

function openDetail(id) {
  const attraction = attractionsData.find((item) => item.id === id);
  if (!attraction) return;
  currentAttr = attraction;
  const fallbackImage = buildPlaceholderImage(attraction);
  const gallery = attraction.photo_urls && attraction.photo_urls.length ? attraction.photo_urls : [getAttractionImage(attraction)];
  const mainImage = document.getElementById('detail-main-image');
  const nameEl = document.getElementById('detail-name');
  const metaTop = document.getElementById('detail-meta-top');
  const metaBottom = document.getElementById('detail-meta-bottom');
  const hoursEl = document.getElementById('detail-hours');
  const feeEl = document.getElementById('detail-fee');
  const durationEl = document.getElementById('detail-duration');
  const descEl = document.getElementById('detail-description');
  const reasonsEl = document.getElementById('detail-reasons');
  const interestsEl = document.getElementById('detail-interests');
  const tipsEl = document.getElementById('detail-tips');
  const addressEl = document.getElementById('detail-address');
  const phoneEl = document.getElementById('detail-phone');
  const websiteEl = document.getElementById('detail-website');
  const websiteCard = document.getElementById('detail-website-card');
  const galleryEl = document.getElementById('detail-gallery');
  const photoNote = document.getElementById('detail-photo-note');
  const hasProviderImage = attraction.has_provider_photo !== false
    && Boolean(attraction.image_url || (Array.isArray(attraction.photo_urls) && attraction.photo_urls.find(Boolean)));

  mainImage.src = gallery[0] || fallbackImage;
  photoNote.style.display = hasProviderImage ? 'none' : 'inline-flex';
  mainImage.onerror = () => {
    mainImage.onerror = null;
    mainImage.src = fallbackImage;
    photoNote.style.display = 'inline-flex';
  };
  nameEl.textContent = attraction.name || 'Attraction';
  const weather = attraction.current_weather;
  const weatherText = weather && weather.condition
    ? `${weatherIcon(weather.condition)} ${weather.condition}${weather.temp !== null && weather.temp !== undefined ? ' · ' + Math.round(weather.temp) + '°C' : ''}`
    : (attraction.weather_suitability || 'Weather unavailable');
  const metaTopParts = [];
  if (appliedFilters.weather) metaTopParts.push(`<span>${weatherText}</span>`);
  if (attraction.category) metaTopParts.push(`<span>${attraction.category}</span>`);
  metaTop.innerHTML = metaTopParts.join('');
  metaBottom.innerHTML = attraction.rating
    ? `<span>⭐ ${Number(attraction.rating).toFixed(1)}</span>`
    : '';
  if (attraction.rating) {
    const reviewLabel = Number(attraction.review_count || 0) > 0
      ? `${Number(attraction.review_count).toLocaleString()} Google reviews`
      : 'Google Maps rating';
    const reviewsUrl = getGoogleReviewsUrl(attraction);
    metaBottom.insertAdjacentHTML(
      'beforeend',
      `<a href="${reviewsUrl}" target="_blank" rel="noopener noreferrer" aria-label="Read this attraction's Google reviews">Read ${reviewLabel} ↗</a>`
    );
  }
  hoursEl.textContent = attraction.hours || '';
  feeEl.textContent = attraction.entry_fee || '';
  hoursEl.closest('.detail-cell').hidden = !attraction.hours;
  feeEl.closest('.detail-cell').hidden = !attraction.entry_fee;
  durationEl.textContent = attraction.estimated_minutes ? `${attraction.estimated_minutes} mins` : 'N/A';
  const description = String(attraction.description || '').trim();
  const unavailableDescriptions = new Set([
    'no description available.',
    'no description available',
    'n/a',
  ]);
  const hasDescription = Boolean(description) && !unavailableDescriptions.has(description.toLowerCase());
  descEl.textContent = hasDescription ? description : '';
  document.getElementById('detail-about-section').hidden = !hasDescription;
  const address = attraction.location || attraction.area || '';
  const phone = attraction.phone || attraction.contact_number || '';
  addressEl.textContent = address;
  phoneEl.textContent = phone;
  document.getElementById('detail-address-card').hidden = !address;
  document.getElementById('detail-phone-card').hidden = !phone;
  const websiteUrl = safeWebsiteUrl(attraction.website || attraction.official_website);
  websiteCard.hidden = !websiteUrl;
  websiteEl.href = websiteUrl || '#';
  document.getElementById('detail-contact-section').hidden = !address && !phone && !websiteUrl;

  const reasons = attraction.reason_tags || [];
  const interests = attraction.interest_tags || attraction.interests || [];
  reasonsEl.innerHTML = reasons.map((reason) => `<span class="detail-pill">${reason}</span>`).join('');
  interestsEl.innerHTML = interests.map((interest) => `<span class="detail-pill">${interest}</span>`).join('');
  document.getElementById('detail-reasons-section').hidden = reasons.length === 0;
  document.getElementById('detail-interests-section').hidden = interests.length === 0;
  tipsEl.innerHTML = (attraction.visitor_tips || []).map((tip) => `<li>${tip}</li>`).join('');

  galleryEl.innerHTML = gallery.map((photo, index) => `
    <button id="thumb-${index}" type="button" class="detail-thumb ${index === 0 ? 'active' : ''}" onclick="setGalleryImg(${index})">
      <img src="${photo || fallbackImage}" alt="Gallery ${index + 1}" onerror="this.onerror=null;this.src='${fallbackImage}';" />
    </button>`).join('');

  document.getElementById('detail-backdrop').classList.add('active');
  document.body.style.overflow = 'hidden';

  syncDetailFavourite(id, favourites.has(id));
  // initialize the interactive map for this attraction
  try {
    updateMapForAttraction(attraction);
  } catch (e) { /* ignore */ }
}

function setGalleryImg(index) {
  if (!currentAttr) return;
  const fallbackImage = buildPlaceholderImage(currentAttr);
  const images = currentAttr.photo_urls && currentAttr.photo_urls.length ? currentAttr.photo_urls : [getAttractionImage(currentAttr)];
  const mainImage = document.getElementById('detail-main-image');
  mainImage.src = images[index] || fallbackImage;
  mainImage.onerror = () => {
    mainImage.onerror = null;
    mainImage.src = fallbackImage;
  };
  images.forEach((_, idx) => {
    document.getElementById(`thumb-${idx}`)?.classList.toggle('active', idx === index);
  });
}

function closeDetail() {
  document.getElementById('detail-backdrop').classList.remove('active');
  document.body.style.overflow = '';
}

function showToast(message) {
  const toastEl = document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}


// Expose to window

window.openDetail = openDetail;
window.toggleFavourite = toggleFavourite;
window.setGalleryImg = setGalleryImg;
window.closeDetail = closeDetail;
