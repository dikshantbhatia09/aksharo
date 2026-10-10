/**
 * High-Resolution 3D Vector Emoji Graphics & Asset Resolver (Pillar 4 §04).
 *
 * Implements Apple / JoyPixels style 3D vector graphics with multi-stop radial/linear
 * gradients, specular reflections, and soft drop shadows:
 * - Scalable vector SVGs (viewBox 0 0 128 128)
 * - Safe data URI generators for zero-dependency Remotion / Web rendering
 * - Pure TypeScript / SVG definitions exportable to browser, node, and Remotion
 */

export const EMOJI_VECTOR_SVGS: Record<string, string> = {
  money: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <linearGradient id="moneyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#85E26E" />
      <stop offset="50%" stop-color="#4CB838" />
      <stop offset="100%" stop-color="#287E18" />
    </linearGradient>
    <linearGradient id="wingGrad" x1="0%" y1="0%" x2="100%" y2="80%">
      <stop offset="0%" stop-color="#F8FAFC" />
      <stop offset="100%" stop-color="#94A3B8" />
    </linearGradient>
    <filter id="glow3d" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.35" />
    </filter>
  </defs>
  <g filter="url(#glow3d)">
    <!-- Wings -->
    <path d="M 12 52 C 2 34 16 14 36 26 C 28 38 32 50 44 58 Z" fill="url(#wingGrad)" />
    <path d="M 116 52 C 126 34 112 14 92 26 C 100 38 96 50 84 58 Z" fill="url(#wingGrad)" />
    <!-- Bill Stack -->
    <rect x="28" y="44" width="72" height="46" rx="8" fill="#1B5E20" />
    <rect x="26" y="40" width="72" height="46" rx="8" fill="url(#moneyGrad)" stroke="#A3E635" stroke-width="2" />
    <circle cx="62" cy="63" r="14" fill="#A3E635" opacity="0.3" />
    <text x="62" y="70" font-family="Arial, sans-serif" font-size="20" font-weight="900" fill="#FFFFFF" text-anchor="middle">$</text>
  </g>
</svg>`,

  fire: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <radialGradient id="fireOuter" cx="50%" cy="80%" r="70%">
      <stop offset="0%" stop-color="#FF3D00" />
      <stop offset="60%" stop-color="#FF1744" />
      <stop offset="100%" stop-color="#D50000" />
    </radialGradient>
    <radialGradient id="fireInner" cx="50%" cy="85%" r="50%">
      <stop offset="0%" stop-color="#FFF59D" />
      <stop offset="40%" stop-color="#FFEA00" />
      <stop offset="80%" stop-color="#FF9100" />
      <stop offset="100%" stop-color="#FF3D00" />
    </radialGradient>
    <filter id="fireGlow">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#FF3D00" flood-opacity="0.6" />
    </filter>
  </defs>
  <g filter="url(#fireGlow)">
    <!-- Outer Flame -->
    <path d="M 64 8 C 72 28 88 42 96 60 C 106 82 96 112 64 120 C 32 112 22 82 32 60 C 40 44 48 30 64 8 Z" fill="url(#fireOuter)" />
    <!-- Inner Flame -->
    <path d="M 64 48 C 70 60 80 70 82 82 C 84 98 76 114 64 116 C 52 114 44 98 46 82 C 48 70 58 60 64 48 Z" fill="url(#fireInner)" />
  </g>
</svg>`,

  rocket: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <linearGradient id="rocketBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="60%" stop-color="#E2E8F0" />
      <stop offset="100%" stop-color="#94A3B8" />
    </linearGradient>
    <linearGradient id="rocketFin" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#EF4444" />
      <stop offset="100%" stop-color="#B91C1C" />
    </linearGradient>
    <linearGradient id="flameGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFEA00" />
      <stop offset="100%" stop-color="#FF3D00" />
    </linearGradient>
    <filter id="rocketShadow">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.4" />
    </filter>
  </defs>
  <g filter="url(#rocketShadow)">
    <!-- Exhaust Flame -->
    <path d="M 36 94 C 28 108 22 124 16 122 C 26 114 36 102 44 92 Z" fill="url(#flameGrad)" />
    <!-- Left Fin -->
    <path d="M 32 72 L 20 96 L 46 90 Z" fill="url(#rocketFin)" />
    <!-- Right Fin -->
    <path d="M 68 106 L 94 118 L 88 92 Z" fill="url(#rocketFin)" />
    <!-- Main Fuselage -->
    <path d="M 112 16 C 88 18 56 38 42 66 L 72 96 C 100 82 120 50 112 16 Z" fill="url(#rocketBody)" />
    <!-- Nose Tip -->
    <path d="M 112 16 C 104 18 94 24 88 32 L 104 48 C 112 42 118 32 112 16 Z" fill="url(#rocketFin)" />
    <!-- Porthole Window -->
    <circle cx="78" cy="50" r="10" fill="#38BDF8" stroke="#0284C7" stroke-width="2" />
    <circle cx="75" cy="47" r="3" fill="#FFFFFF" opacity="0.8" />
  </g>
</svg>`,

  dead: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <radialGradient id="skullGrad" cx="45%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="70%" stop-color="#CBD5E1" />
      <stop offset="100%" stop-color="#64748B" />
    </radialGradient>
    <filter id="skullShadow">
      <feDropShadow dx="0" dy="6" stdDeviation="5" flood-color="#000000" flood-opacity="0.4" />
    </filter>
  </defs>
  <g filter="url(#skullShadow)">
    <!-- Cranium -->
    <ellipse cx="64" cy="54" rx="46" ry="42" fill="url(#skullGrad)" />
    <!-- Jaw -->
    <path d="M 44 86 L 44 108 C 44 114 84 114 84 108 L 84 86 Z" fill="url(#skullGrad)" />
    <!-- Eye Sockets -->
    <ellipse cx="46" cy="62" rx="14" ry="16" fill="#1E293B" />
    <ellipse cx="82" cy="62" rx="14" ry="16" fill="#1E293B" />
    <!-- Nasal Cavity -->
    <path d="M 64 74 L 58 88 L 70 88 Z" fill="#1E293B" />
    <!-- Teeth -->
    <line x1="54" y1="94" x2="54" y2="108" stroke="#475569" stroke-width="3" stroke-linecap="round" />
    <line x1="64" y1="94" x2="64" y2="108" stroke="#475569" stroke-width="3" stroke-linecap="round" />
    <line x1="74" y1="94" x2="74" y2="108" stroke="#475569" stroke-width="3" stroke-linecap="round" />
  </g>
</svg>`,

  growth: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <linearGradient id="chartLine" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#10B981" />
      <stop offset="100%" stop-color="#00FFA3" />
    </linearGradient>
    <filter id="chartGlow">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#10B981" flood-opacity="0.5" />
    </filter>
  </defs>
  <g filter="url(#chartGlow)">
    <!-- Grid Frame -->
    <rect x="14" y="14" width="100" height="100" rx="12" fill="#0F172A" stroke="#334155" stroke-width="2" />
    <line x1="24" y1="98" x2="104" y2="98" stroke="#334155" stroke-width="2" />
    <line x1="24" y1="64" x2="104" y2="64" stroke="#334155" stroke-width="1" stroke-dasharray="4 4" />
    <!-- Trend Line -->
    <polyline points="26,90 50,72 74,80 102,34" fill="none" stroke="url(#chartLine)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
    <!-- Arrowhead -->
    <polygon points="104,26 106,44 92,36" fill="#00FFA3" />
  </g>
</svg>`,

  mindblown: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <radialGradient id="faceGrad" cx="45%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#FFEB3B" />
      <stop offset="70%" stop-color="#FBC02D" />
      <stop offset="100%" stop-color="#F57F17" />
    </radialGradient>
    <radialGradient id="blastGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="30%" stop-color="#FF9100" />
      <stop offset="70%" stop-color="#D50000" />
      <stop offset="100%" stop-color="#5D4037" />
    </radialGradient>
  </defs>
  <!-- Explosion Cloud Top -->
  <path d="M 64 6 C 42 6 30 20 32 36 C 18 38 12 50 24 60 C 44 64 84 64 104 60 C 116 50 110 38 96 36 C 98 20 86 6 64 6 Z" fill="url(#blastGrad)" />
  <!-- Face Bottom -->
  <path d="M 28 58 C 28 94 44 116 64 116 C 84 116 100 94 100 58 Z" fill="url(#faceGrad)" />
  <!-- Wide Stunned Eyes -->
  <circle cx="48" cy="74" r="8" fill="#FFFFFF" />
  <circle cx="48" cy="74" r="4" fill="#212121" />
  <circle cx="80" cy="74" r="8" fill="#FFFFFF" />
  <circle cx="80" cy="74" r="4" fill="#212121" />
  <!-- Open O Mouth -->
  <ellipse cx="64" cy="98" rx="8" ry="12" fill="#5D4037" />
</svg>`,

  warning: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <linearGradient id="warnGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FDE047" />
      <stop offset="60%" stop-color="#EAB308" />
      <stop offset="100%" stop-color="#CA8A04" />
    </linearGradient>
    <filter id="warnShadow">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.4" />
    </filter>
  </defs>
  <g filter="url(#warnShadow)">
    <path d="M 64 14 L 118 106 C 122 112 118 118 110 118 L 18 118 C 10 118 6 112 10 106 Z" fill="url(#warnGrad)" stroke="#78350F" stroke-width="4" stroke-linejoin="round" />
    <line x1="64" y1="48" x2="64" y2="82" stroke="#1E293B" stroke-width="10" stroke-linecap="round" />
    <circle cx="64" cy="98" r="5" fill="#1E293B" />
  </g>
</svg>`,

  crying: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <radialGradient id="cryFace" cx="45%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#60A5FA" />
      <stop offset="60%" stop-color="#3B82F6" />
      <stop offset="100%" stop-color="#1D4ED8" />
    </radialGradient>
    <linearGradient id="tearStream" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#93C5FD" />
      <stop offset="100%" stop-color="#38BDF8" />
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="52" fill="url(#cryFace)" />
  <!-- Closed Weeping Eyes -->
  <path d="M 38 52 Q 48 64 58 52" fill="none" stroke="#1E3A8A" stroke-width="5" stroke-linecap="round" />
  <path d="M 70 52 Q 80 64 90 52" fill="none" stroke="#1E3A8A" stroke-width="5" stroke-linecap="round" />
  <!-- Massive Waterfall Tears -->
  <rect x="42" y="60" width="12" height="54" rx="6" fill="url(#tearStream)" />
  <rect x="74" y="60" width="12" height="54" rx="6" fill="url(#tearStream)" />
  <!-- Open Screaming Mouth -->
  <ellipse cx="64" cy="92" rx="16" ry="12" fill="#1E3A8A" />
</svg>`,

  crown: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <linearGradient id="goldCrown" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FEF08A" />
      <stop offset="40%" stop-color="#EAB308" />
      <stop offset="100%" stop-color="#A16207" />
    </linearGradient>
  </defs>
  <path d="M 18 94 L 26 38 L 48 64 L 64 26 L 80 64 L 102 38 L 110 94 Z" fill="url(#goldCrown)" stroke="#78350F" stroke-width="3" stroke-linejoin="round" />
  <!-- Jewels -->
  <circle cx="26" cy="34" r="5" fill="#EF4444" />
  <circle cx="64" cy="22" r="6" fill="#3B82F6" />
  <circle cx="102" cy="34" r="5" fill="#10B981" />
  <rect x="22" y="94" width="84" height="12" rx="4" fill="#CA8A04" />
</svg>`,

  trophy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <linearGradient id="trophyGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FDE047" />
      <stop offset="60%" stop-color="#EAB308" />
      <stop offset="100%" stop-color="#854D0E" />
    </linearGradient>
  </defs>
  <!-- Cup -->
  <path d="M 36 24 L 92 24 C 92 56 78 72 64 74 C 50 72 36 56 36 24 Z" fill="url(#trophyGold)" />
  <!-- Handles -->
  <path d="M 36 32 C 18 32 18 56 36 60" fill="none" stroke="#CA8A04" stroke-width="6" stroke-linecap="round" />
  <path d="M 92 32 C 110 32 110 56 92 60" fill="none" stroke="#CA8A04" stroke-width="6" stroke-linecap="round" />
  <!-- Stem & Base -->
  <rect x="58" y="74" width="12" height="22" fill="#A16207" />
  <rect x="40" y="96" width="48" height="18" rx="4" fill="#475569" />
</svg>`,

  target: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <circle cx="64" cy="64" r="52" fill="#EF4444" />
  <circle cx="64" cy="64" r="40" fill="#FFFFFF" />
  <circle cx="64" cy="64" r="28" fill="#EF4444" />
  <circle cx="64" cy="64" r="16" fill="#FFFFFF" />
  <circle cx="64" cy="64" r="8" fill="#EF4444" />
  <!-- Arrow -->
  <line x1="88" y1="40" x2="64" y2="64" stroke="#1E293B" stroke-width="6" stroke-linecap="round" />
  <polygon points="98,30 96,44 84,42" fill="#F59E0B" />
</svg>`,

  heart: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <defs>
    <radialGradient id="heartRed" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#FF4B4B" />
      <stop offset="60%" stop-color="#E11D48" />
      <stop offset="100%" stop-color="#9F1239" />
    </radialGradient>
  </defs>
  <path d="M 64 112 C 34 88 12 64 12 40 C 12 22 26 12 42 12 C 54 12 60 18 64 24 C 68 18 74 12 86 12 C 102 12 116 22 116 40 C 116 64 94 88 64 112 Z" fill="url(#heartRed)" />
</svg>`,

  hundred: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <text x="64" y="80" font-family="'Impact', 'Arial Black', sans-serif" font-size="54" font-weight="900" fill="#DC2626" text-anchor="middle" letter-spacing="-2">100</text>
  <line x1="20" y1="96" x2="108" y2="96" stroke="#DC2626" stroke-width="6" stroke-linecap="round" />
  <line x1="20" y1="106" x2="108" y2="106" stroke="#DC2626" stroke-width="6" stroke-linecap="round" />
</svg>`,
};

/**
 * Returns the SVG string for a given emoji asset key, or null if not found.
 */
export function getEmojiSvg(assetKey: string): string | null {
  // Normalize key (e.g. "3d-fire.svg" -> "fire", "fire" -> "fire")
  const normalized = assetKey
    .replace(/^3d-/, "")
    .replace(/\.svg$/, "")
    .toLowerCase();

  return EMOJI_VECTOR_SVGS[normalized] ?? null;
}

/**
 * Returns an inline SVG data URI safe for use in `<img src="..." />` or CSS backgrounds.
 */
export function getEmojiDataUri(assetKey: string): string | null {
  const svg = getEmojiSvg(assetKey);
  if (!svg) return null;
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, "%27")
    .replace(/"/g, "%22");
  return `data:image/svg+xml;charset=utf-8,${encoded}`;
}
