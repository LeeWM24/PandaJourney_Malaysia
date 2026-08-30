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

function readJsonData(elementId, fallback) {
  const el = document.getElementById(elementId);
  if (!el) return fallback;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return fallback;
  }
}

const attractionsData = readJsonData('attraction-data', []);

const searchState = readJsonData('search-state', {
  searched: false,
  filters: { destination: '', interests: [], min_rating: '0', weather_aware: false },
});

const favourites = new Set();

const favouriteDocIds = new Map();
let currentUser = null;
let hasSearched = !!searchState.searched;
let appliedFilters = {
  interests: searchState.filters.interests || [],
  minRating: searchState.filters.min_rating || '0',
  weather: !!searchState.filters.weather_aware,
};
let currentAttr = null;
let toastTimer = null;

// Pagination: render only PAGE_SIZE cards for the current page, with real
// page-number navigation (rather than a cumulative "show more" list).
const PAGE_SIZE = 5;
let currentPage = 1;

function resetPagination() {
  currentPage = 1;
}

document.addEventListener('DOMContentLoaded', () => {
  initializeChipState();
  bindFilterEvents();
  bindPanelEvents();
  renderCards();
  updateFavUI();
  bindSearchLoadingOverlay();
  bindDestinationSuggestions();

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
  const overlay = document.getElementById('planner-loading-overlay');
  if (!form || !overlay) return;

  form.addEventListener('submit', () => {
    const destination = document.getElementById('destination');
    if (destination && !destination.value.trim()) {
      return; // let native "required" validation handle empty destination
    }
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
  });
}

// Custom "Google Maps style" type-ahead for the destination field, used
// only when no Google Places key is configured (see PANDA_HAS_GOOGLE_MAPS,
// set inline in smart_attraction.html). Debounces keystrokes, hits our
// own /smart-attraction/suggest endpoint (backed by cached Nominatim
// results), and fills the same hidden lat/lng inputs Google's widget uses
// — so the backend doesn't need to know which source picked the place.
function bindDestinationSuggestions() {
  if (window.PANDA_HAS_GOOGLE_MAPS) return; // Google's own widget handles this instead

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
      closeDropdown();
      return;
    }

    dropdown.innerHTML = items.map((item, index) => `
      <div class="destination-suggestion-item" role="option" data-index="${index}">
        📍
        <span>
          <span class="destination-suggestion-name">${item.name || item.display_name}</span>
          ${item.subtitle ? `<span class="destination-suggestion-sub">${item.subtitle}</span>` : ''}
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

    if (query.length < 3) {
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
      favouriteDocIds.set(data.name, docSnap.id);

      const match = attractionsData.find((item) => item.name === data.name);
      if (match) favourites.add(match.id);
    });

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

    // Point the "Open in OpenStreetMap" link at this attraction's coordinates
    if (linkEl) {
      linkEl.href = getMapsUrl({ latitude: lat, longitude: lng });
      linkEl.style.display = 'inline-flex';
    }
  }, 150);
}

function bindFilterEvents() {

  document.getElementById('sort-select').addEventListener('change', () => { resetPagination(); renderCards(); });
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
}

// Return an OpenStreetMap URL
function getMapsUrl(attraction, zoom = 17) {
  if (!attraction) return '';
  const lat = Number(attraction.latitude || attraction.lat || attraction.latitude_deg || 0);
  const lng = Number(attraction.longitude || attraction.lon || attraction.lng || 0);
  if (lat && lng) {
    return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}#map=${zoom}/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}`;
  }
  const query = `${attraction.name || ''} ${attraction.area || attraction.location || ''}`.trim();
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

function clearFilters() {
  window.location.href = window.location.pathname;
}

const RATING_MIN = { '0': 0, '3.0': 3, '4.0': 4, '4.5': 4.5 };

function getFilteredAttractions() {
  // Show all attractions by default until the user applies filters/search
  if (!hasSearched) return Array.isArray(attractionsData) ? [...attractionsData] : [];
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
    if (mode === 'rating') return Number(b.rating || 0) - Number(a.rating || 0);
    if (mode === 'rating-asc') return Number(a.rating || 0) - Number(b.rating || 0);
    if (mode === 'nearest') return Number(a.distance_km ?? Infinity) - Number(b.distance_km ?? Infinity);
    return 0;
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

  const label = hasSearched ? `result${sorted.length !== 1 ? 's' : ''}` : 'attractions';
  countEl.innerHTML = `Showing <strong>${visible.length}</strong> of <strong>${sorted.length}</strong> ${label}`;
  if (!hasSearched) {
    noteEl.textContent = 'Showing all attractions — apply filters to refine results.';
  } else if (sorted.length === 0) {
    noteEl.textContent = 'No attractions matched your selections. Try relaxing one filter.';
  } else {
    noteEl.textContent = `Found ${sorted.length} attraction${sorted.length !== 1 ? 's' : ''} that match your filters.`;
  }

  if (appliedFilters.weather) {
    weatherEl.style.display = 'block';
    weatherEl.textContent = 'Weather-aware filtering is enabled.';
  } else {
    weatherEl.style.display = 'none';
    weatherEl.textContent = '';
  }

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
          <div class="empty-desc">Try a different destination, interest, or rating range.</div>
        </div>
      </div>`;
    return;
  }

  grid.innerHTML = visible.map((attraction) => buildCard(attraction)).join('');
  updateCardFavourites();
  renderPagination(totalPages, paginationWrap);
}

// Builds Prev / page-number / Next controls — 5 attractions per page,
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

function buildCard(attraction) {
  const isFav = favourites.has(attraction.id);
  const weatherBadge = buildWeatherBadgeHtml(attraction);

  const reasons = (attraction.reason_tags || []).map((reason) => `<span class="reason-tag">${reason}</span>`).join('');
  const locationLabel = attraction.location || attraction.area || 'Unknown location';
  const ratingText = attraction.rating ? Number(attraction.rating).toFixed(1) : 'N/A';

  return `
    <article class="attr-card">
      <button class="attr-card-img-wrap" type="button" onclick="openDetail(${attraction.id})" aria-label="View details for ${attraction.name}">
        <img src="${attraction.image_url || PLACEHOLDER_IMAGE}" alt="${attraction.name}" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';" />
        <div class="attr-card-img-overlay"><span class="img-hint">View details</span></div>
        <div class="img-badge-tr">${weatherBadge}</div>
        <div class="img-fav-badge ${isFav ? 'show' : ''}">★</div>
      </button>
      <div class="attr-card-body">
        <div class="attr-card-title-row">
          <div class="attr-card-name">${attraction.name}</div>
          <div class="attr-card-rating">⭐ ${ratingText}</div>
        </div>
        <div class="attr-card-meta">
          <span class="reason-tag" style="background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe;">${attraction.category || ''}</span>
          <span class="attr-card-loc">📍 ${locationLabel}</span>
        </div>
        <div class="attr-card-reasons">${reasons}</div>
        <div class="attr-card-actions">
          <button class="btn-view-details" type="button" onclick="openDetail(${attraction.id})">View details</button>
          <button class="btn-fav ${isFav ? 'active' : ''}" id="btn-fav-${attraction.id}" type="button" onclick="toggleFavourite(${attraction.id})" title="${isFav ? 'Remove from favourites' : 'Save to favourites'}">${isFav ? '★' : '☆'}</button>
        </div>
      </div>
    </article>`;
}

function updateCardFavourites() {
  document.querySelectorAll('.btn-fav').forEach((button) => {
    const id = Number(button.id.replace('btn-fav-', ''));
    const isFav = favourites.has(id);
    button.classList.toggle('active', isFav);
    button.textContent = isFav ? '★' : '☆';
    button.title = isFav ? 'Remove from favourites' : 'Save to favourites';
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
    const existingDocId = favouriteDocIds.get(attraction.name);

    if (existingDocId) {
      await deleteDoc(doc(db, FAVOURITES_COLLECTION, existingDocId));
      favouriteDocIds.delete(attraction.name);
      favourites.delete(id);
      attraction.is_favourite = false;
      showToast('Removed from favourites');
    } else {
      const docRef = await addDoc(collection(db, FAVOURITES_COLLECTION), {
        user_id: currentUser.uid,
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
      favouriteDocIds.set(attraction.name, docRef.id);
      favourites.add(id);
      attraction.is_favourite = true;
      showToast('★ Saved to favourites!');
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
  favBtn.textContent = active ? '★ Saved to favourite' : 'Save as favourite';
  favBtn.classList.toggle('saved', active);
  favBtn.dataset.favId = id;
}

function openDetail(id) {
  const attraction = attractionsData.find((item) => item.id === id);
  if (!attraction) return;
  currentAttr = attraction;
  const gallery = attraction.photo_urls && attraction.photo_urls.length ? attraction.photo_urls : [attraction.image_url || ''];
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
  const areaEl = document.getElementById('detail-area');
  const sourceEl = document.getElementById('detail-source');
  const galleryEl = document.getElementById('detail-gallery');

  mainImage.src = gallery[0] || PLACEHOLDER_IMAGE;
  mainImage.onerror = () => {
    mainImage.onerror = null;
    mainImage.src = PLACEHOLDER_IMAGE;
  };
  nameEl.textContent = attraction.name || 'Attraction';
  const weather = attraction.current_weather;
  const weatherText = weather && weather.condition
    ? `${weatherIcon(weather.condition)} ${weather.condition}${weather.temp !== null && weather.temp !== undefined ? ' · ' + Math.round(weather.temp) + '°C' : ''}`
    : (attraction.weather_suitability || 'Weather unavailable');
  metaTop.innerHTML = `
    <span>${weatherText}</span>
    <span>${attraction.category || ''}</span>`;
  metaBottom.innerHTML = `
    <span>${attraction.area || attraction.location || ''}</span>
    <span>⭐ ${attraction.rating ? Number(attraction.rating).toFixed(1) : 'N/A'}</span>`;
  hoursEl.textContent = attraction.hours || 'N/A';
  feeEl.textContent = attraction.entry_fee || 'N/A';
  durationEl.textContent = attraction.estimated_minutes ? `${attraction.estimated_minutes} mins` : 'N/A';
  descEl.textContent = attraction.description || 'No description available.';
  areaEl.textContent = attraction.area || attraction.location || 'Unknown location';
  sourceEl.textContent = attraction.source || 'SerpApi (Google Maps)';

  reasonsEl.innerHTML = (attraction.reason_tags || []).map((reason) => `<span class="detail-pill">${reason}</span>`).join('');
  interestsEl.innerHTML = (attraction.interest_tags || attraction.interests || []).map((interest) => `<span class="detail-pill">${interest}</span>`).join('');
  tipsEl.innerHTML = (attraction.visitor_tips || []).map((tip) => `<li><span class="tip-dot">•</span>${tip}</li>`).join('');

  galleryEl.innerHTML = gallery.map((photo, index) => `
    <button id="thumb-${index}" type="button" class="detail-thumb ${index === 0 ? 'active' : ''}" onclick="setGalleryImg(${index})">
      <img src="${photo || PLACEHOLDER_IMAGE}" alt="Gallery ${index + 1}" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';" />
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
  const images = currentAttr.photo_urls && currentAttr.photo_urls.length ? currentAttr.photo_urls : [currentAttr.image_url || ''];
  document.getElementById('detail-main-image').src = images[index] || PLACEHOLDER_IMAGE;
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
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}


// Expose to window

window.openDetail = openDetail;
window.toggleFavourite = toggleFavourite;
window.setGalleryImg = setGalleryImg;