const axios = require('axios');

/**
 * Lebanon legal speed limits based on road classification
 */
const LEBANON_LEGAL_LIMITS = {
  motorway: 120,        // Major highways (Beirut-Damascus, etc.)
  trunk: 100,           // Main highways
  primary: 80,          // Primary roads between cities
  secondary: 80,        // Secondary roads
  tertiary: 60,         // Tertiary roads
  residential: 50,      // Residential areas
  living_street: 25,    // Small residential streets, alleys, shared spaces
  service: 25,          // Service roads, driveways, parking areas
  track: 25,            // Unpaved tracks, very small roads
  unclassified: 50,     // Unclassified roads (assume urban)
  default: 60,          // Default fallback
};

/**
 * Fetch road data from OSM and determine speed limit
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<{speedLimit: number, source: string, osmSpeed: number|null, roadType: string|null}>}
 */
async function getSpeedLimit(latitude, longitude) {
  try {
    // Query Overpass API for roads near this location
    // Get ALL roads in 50m radius (with or without maxspeed)
    const query = `
      [out:json][timeout:5];
      way(around:50,${latitude},${longitude})["highway"];
      out tags;
    `;
    
    const response = await axios.post(
      'https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(query)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 5000,
      }
    );
    
    if (response.data && response.data.elements && response.data.elements.length > 0) {
      // Get the first road
      const road = response.data.elements[0];
      const roadType = road.tags.highway;
      const maxspeedTag = road.tags.maxspeed;
      
      let osmSpeed = null;
      if (maxspeedTag) {
        // Parse OSM speed limit
        const speedMatch = maxspeedTag.match(/(\d+)/);
        if (speedMatch) {
          osmSpeed = parseInt(speedMatch[1], 10);
          
          // Convert mph to km/h if needed
          if (maxspeedTag.toLowerCase().includes('mph')) {
            osmSpeed = Math.round(osmSpeed * 1.60934);
          }
        }
      }
      
      // Get Lebanon legal limit based on road type
      const legalLimit = LEBANON_LEGAL_LIMITS[roadType] || LEBANON_LEGAL_LIMITS.default;
      
      // Decision logic: Compare OSM vs Legal
      let finalSpeed = legalLimit;
      let source = 'legal';
      
      if (osmSpeed !== null) {
        // OSM speed exists - validate it
        const difference = Math.abs(osmSpeed - legalLimit);
        
        if (difference <= 20) {
          // OSM speed is reasonable (within 20 km/h of legal limit)
          finalSpeed = osmSpeed;
          source = 'osm';
        } else {
          // OSM speed seems off - use legal limit but log it
          console.warn(`OSM speed (${osmSpeed}) differs significantly from legal limit (${legalLimit}) for ${roadType}`);
          source = 'legal_validated';
        }
      }
      
      return {
        speedLimit: finalSpeed,
        source,           // 'osm', 'legal', or 'legal_validated'
        osmSpeed,         // Original OSM value (or null)
        roadType,         // OSM road classification
        legalLimit,       // Lebanon legal limit for this road type
      };
    }
    
    // No road found - return conservative default
    return {
      speedLimit: LEBANON_LEGAL_LIMITS.default,
      source: 'default',
      osmSpeed: null,
      roadType: null,
      legalLimit: LEBANON_LEGAL_LIMITS.default,
    };
  } catch (error) {
    console.warn('Error fetching speed limit:', error.message);
    // Return default on error
    return {
      speedLimit: LEBANON_LEGAL_LIMITS.default,
      source: 'default_error',
      osmSpeed: null,
      roadType: null,
      legalLimit: LEBANON_LEGAL_LIMITS.default,
    };
  }
}

/**
 * Cache for speed limits to avoid excessive API calls
 */
const speedLimitCache = new Map();
const CACHE_DURATION_MS = 120000; // 2 minutes (roads don't change often)

/**
 * Get speed limit with caching
 * Uses a grid-based cache key (rounds to nearest 0.001 degrees ~100m)
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<{speedLimit: number, source: string, osmSpeed: number|null, roadType: string|null}>}
 */
async function getSpeedLimitCached(latitude, longitude) {
  // Round to 3 decimal places (~100m grid)
  const lat = Math.round(latitude * 1000) / 1000;
  const lng = Math.round(longitude * 1000) / 1000;
  const cacheKey = `${lat},${lng}`;
  
  const cached = speedLimitCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
    return cached.data;
  }
  
  const data = await getSpeedLimit(latitude, longitude);
  
  // Cache the result
  speedLimitCache.set(cacheKey, {
    data,
    timestamp: Date.now(),
  });
  
  // Clear old cache entries (keep last 100)
  if (speedLimitCache.size > 100) {
    const firstKey = speedLimitCache.keys().next().value;
    speedLimitCache.delete(firstKey);
  }
  
  return data;
}

module.exports = { getSpeedLimit, getSpeedLimitCached, LEBANON_LEGAL_LIMITS };
