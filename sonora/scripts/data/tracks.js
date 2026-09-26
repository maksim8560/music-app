/* ==========================================================================
   data/tracks.js — the demo catalogue
   Every track is metadata + a seed for the generative music engine, so the
   player ships with real, endless music and zero binary assets.
   ========================================================================== */

export const GENRES = {
  ambient: { label: 'Эмбиент', dot: 'ambient' },
  lofi: { label: 'Lo-Fi', dot: 'lofi' },
  electronic: { label: 'Электроника', dot: 'electronic' },
  neo: { label: 'Неоклассика', dot: 'neo' },
  local: { label: 'Загруженное', dot: 'local' },
};


/* --------------------------------------------------------------------------
   The player ships with an empty shelf on purpose. Music is added from the
   admin panel: a direct link to an audio file, a description and a cover
   image. Nothing is bundled, so the page weighs only the code.

   The generative engine is still here — an admin can add a synthesised
   track as well, and `resetCatalogue()` returns to this empty state.
   -------------------------------------------------------------------------- */
export const CATALOG = [];
