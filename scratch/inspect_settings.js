const fs = require("fs");
const path = require("path");

const dir = "c:/Dikshant/Crest Mond/Product 2/05-build/montaj/scratch/extracted_styles/Edit/Titles/Sv Real Estate Text Anim";

function inspectSetting(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const fontMatches = [...content.matchAll(/Font\s*=\s*(?:Input\s*\{\s*Value\s*=\s*)?"([^"]+)"/gi)].map(m => m[1]);
  const styleMatches = [...content.matchAll(/Style\s*=\s*(?:Input\s*\{\s*Value\s*=\s*)?"([^"]+)"/gi)].map(m => m[1]);
  const alignMatch = content.match(/HorizontalJustificationNew\s*=\s*Input\s*\{\s*Value\s*=\s*([0-9.]+)/i);
  const sizeMatch = content.match(/Size\s*=\s*Input\s*\{\s*Value\s*=\s*([0-9.]+)/i);
  const trackMatch = content.match(/CharacterSpacingClone\s*=\s*Input\s*\{\s*Value\s*=\s*([0-9.]+)/i);

  // Look for modifiers or animation blocks
  const modifiers = [...content.matchAll(/([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+Modifier)/g)].map(m => `${m[1]}: ${m[2]}`);

  return {
    file: path.relative(dir, filePath),
    fonts: fontMatches,
    styles: styleMatches,
    size: sizeMatch ? parseFloat(sizeMatch[1]) : null,
    tracking: trackMatch ? parseFloat(trackMatch[1]) : null,
    modifiers: modifiers.slice(0, 5)
  };
}

function walk(curr) {
  const files = fs.readdirSync(curr);
  for (const f of files) {
    const full = path.join(curr, f);
    if (fs.statSync(full).isDirectory()) {
      walk(full);
    } else if (f.endsWith(".setting")) {
      console.log(inspectSetting(full));
    }
  }
}

walk(dir);
