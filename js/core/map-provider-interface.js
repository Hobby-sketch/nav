/**
 * MotoDash — map-provider-interface.js
 * The contract every map rendering backend must implement.
 *
 * ARCHITECTURE NOTE
 * ──────────────────
 * maps.js (business logic: search UX, navigation state machine, trip
 * integration) is written entirely against THIS interface. It never
 * imports maplibre-gl, never touches a maplibregl.Map instance
 * directly, and never knows the active engine's name. This is what
 * satisfies "provider peta harus dapat diganti tanpa mengubah business
 * logic aplikasi" — swapping engines means writing one new class that
 * implements these methods and changing one line in config.js.
 *
 * Every method listed here MUST be implemented by a concrete provider.
 * Methods return Promises where the underlying operation is async.
 */

'use strict';

class MapProviderInterface {

    /**
     * Create and mount the map into a DOM container.
     * @param {string} containerId
     * @param {{theme:string, time:string, center:{lat,lng}, zoom:number}} opts
     * @returns {Promise<void>}
     */
    async init(containerId, opts) { throw new Error('init() not implemented'); }

    /** Pan/zoom the camera. */
    setView(lat, lng, zoom, animate = true) { throw new Error('setView() not implemented'); }

    /** @returns {number} current zoom level */
    getZoom() { throw new Error('getZoom() not implemented'); }

    setZoom(z) { throw new Error('setZoom() not implemented'); }

    /** Create/update the rider's own position marker (rotates with heading). */
    updateUserMarker(lat, lng, headingDeg = 0) { throw new Error('updateUserMarker() not implemented'); }

    /** Place/replace the destination pin. */
    placeDestinationMarker(lat, lng, label = '') { throw new Error('placeDestinationMarker() not implemented'); }

    removeDestinationMarker() { throw new Error('removeDestinationMarker() not implemented'); }

    /** Fit camera to a set of [{lat,lng}] points with pixel padding. */
    fitBounds(points, paddingPx = 40) { throw new Error('fitBounds() not implemented'); }

    /** Draw (or replace) the active route as a line on the map. */
    drawRoute(coordinatesLatLng) { throw new Error('drawRoute() not implemented'); }

    clearRoute() { throw new Error('clearRoute() not implemented'); }

    /**
     * Forward geocode a free-text query.
     * @returns {Promise<Array<{lat:number,lng:number,name:string,address:string}>>}
     */
    async geocode(query) { throw new Error('geocode() not implemented'); }

    /**
     * Compute a route between two points.
     * @returns {Promise<{coordinates:Array<{lat,lng}>, distanceM:number,
     *                     durationS:number, steps:Array<RouteStep>}>}
     * RouteStep = { type, modifier, name, distanceM, durationS, location:{lat,lng} }
     */
    async route(from, to) { throw new Error('route() not implemented'); }

    /** Swap the visual basemap style (called on theme/day-night change). */
    setStyle(theme, time) { throw new Error('setStyle() not implemented'); }

    /**
     * OPTIONAL: load an independent, non-theme-tinted style preset
     * (e.g. Street/Dark/Grayscale/Minimal quick-setting). Providers
     * that don't support style presets may omit this.
     */
    setStylePreset(presetId) { throw new Error('setStylePreset() not implemented'); }

    /** Must be called whenever the map's container becomes visible/resized. */
    resize() { throw new Error('resize() not implemented'); }

    /** Subscribe to provider-agnostic events: 'userdrag' | 'click' | 'styleload'. */
    on(event, handler) { throw new Error('on() not implemented'); }
    off(event, handler) { throw new Error('off() not implemented'); }

    /** Release all resources (workers, listeners, DOM). */
    destroy() { throw new Error('destroy() not implemented'); }
}

window.MapProviderInterface = MapProviderInterface;
console.log('[MapProviderInterface] Loaded ✓');
