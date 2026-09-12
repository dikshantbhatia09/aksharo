const fs = require("fs");
const path = require("path");

function examine(file) {
  const content = fs.readFileSync(file, "utf8");
  console.log("=== " + path.basename(file) + " ===");
  // Look for StyledText, Color, Shading, Center, Layout
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("StyledText") || l.startsWith("Red1") || l.startsWith("Green1") || l.startsWith("Blue1") ||
        l.startsWith("Alpha1") || l.startsWith("Center") || l.startsWith("Size") || l.startsWith("CharacterSpacing") ||
        l.startsWith("LineSpacing") || l.startsWith("Shading") || l.startsWith("Softness") || l.startsWith("Transform")) {
      console.log("  " + l);
    }
  }
}

const dir = "c:/Dikshant/Crest Mond/Product 2/05-build/montaj/scratch/extracted_styles/Edit/Titles/Sv Real Estate Text Anim";
examine(dir + "/word by word 1.setting");
examine(dir + "/FLICKER.setting");
examine(dir + "/Pair 1/left to right.setting");
examine(dir + "/Pair 6/Bounce.setting");
examine(dir + "/char by char 1.setting");
