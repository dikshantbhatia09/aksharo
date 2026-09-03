// Aksharo Panel — ExtendScript host functions for After Effects (CEP 12).
//
// ExtendScript is an ES3-based dialect (Adobe's own docs describe it as "based on JavaScript
// (ECMA-262 edition 3) with... extensions" — https://ae-scripting.docsforadobe.dev/), so this
// file is deliberately restricted to a small ES3-compatible subset: `var` only (no let/const),
// no arrow functions, no template literals, no classes, no destructuring, no for-of/for-in over
// arrays, no Array.prototype.forEach/map/filter (ES5). `eslint.extendscript.mjs` in this package
// enforces this mechanically (`npm run lint:jsx`) so a future edit can't silently reintroduce an
// ES5+ feature CEP's ExtendScript engine would throw on.
//
// Every function here is intentionally small and independently callable via
// `CSInterface.evalScript("$.aksharo.<fn>(" + JSON.stringify(args) + ")")` from the panel's TS
// side (`src/host/ae.ts`'s `createRealAeHost`, not implemented until Gate C — see that file's
// header). Behaviour of the actual AE object-model calls below (`app.beginUndoGroup`,
// `layers.addText`, `TextDocument`, `renderQueue`, `importFile`) is UNVERIFIED until a human runs
// `docs/GATE-C-CHECKLIST.md` against a real After Effects install; nothing here is fabricated
// beyond what the cited docs describe (see `src/host/ae.ts`'s header for the exact URLs).
//
// $.aksharo is the dispatcher namespace CEP's `evalScript` calls into (a common ExtendScript/CEP
// idiom: https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/CEP%2012%20HTML%20Extension%20Cookbook.md).
if (typeof $.aksharo === "undefined") {
  $.aksharo = {};
}

// --- helpers ---------------------------------------------------------------------------------

function aksharo_ok(value) {
  return JSON.stringify({ ok: true, value: value });
}

function aksharo_err(message) {
  return JSON.stringify({ ok: false, error: String(message) });
}

function aksharo_activeComp() {
  var item = app.project.activeItem;
  if (item === null || !(item instanceof CompItem)) {
    return null;
  }
  return item;
}

// --- readComp ----------------------------------------------------------------------------------

$.aksharo.readComp = function () {
  try {
    var comp = aksharo_activeComp();
    if (comp === null) {
      return aksharo_ok(null);
    }
    var workArea = null;
    if (comp.workAreaDuration > 0) {
      workArea = { startSeconds: comp.workAreaStart, durationSeconds: comp.workAreaDuration };
    }
    return aksharo_ok({
      compId: String(comp.id),
      name: comp.name,
      frameRate: comp.frameRate,
      width: comp.width,
      height: comp.height,
      workArea: workArea,
    });
  } catch (e) {
    return aksharo_err(e);
  }
};

// --- mixdownToWav --------------------------------------------------------------------------
//
// GATE C (unverified): the exact AME hand-off. This function stakes out the shape
// `mixdownToWav(compId, inPoint, outPoint, path)` per the brief and queues an audio-only render
// via `app.project.renderQueue`; whether an audio-only output module needs a specific template
// name, and whether AME must be queued via `app.project.renderQueue.queueInAME` vs. a local
// render-and-wait, is exactly what Gate C confirms (see docs/GATE-C-CHECKLIST.md, "AME mixdown").

$.aksharo.mixdownToWav = function (compId, inPoint, outPoint, path) {
  try {
    var comp = aksharo_activeComp();
    if (comp === null || String(comp.id) !== String(compId)) {
      return aksharo_err("mixdownToWav: comp " + compId + " is not the active item");
    }
    var rqItem = app.project.renderQueue.items.add(comp);
    rqItem.timeSpanStart = inPoint;
    rqItem.timeSpanDuration = outPoint - inPoint;
    // GATE C: confirm the audio-only output-module template name on a real AE install; using
    // a plain marker string here rather than guessing a template name that may not exist.
    var outputModule = rqItem.outputModule(1);
    outputModule.file = new File(path);
    app.project.renderQueue.queueInAME(false);
    return aksharo_ok({ path: path });
  } catch (e) {
    return aksharo_err(e);
  }
};

// --- addTextLayers (brief item 1: one styled text layer per segment, one undo group) --------

$.aksharo.addTextLayers = function (compId, specsJson) {
  var specs = JSON.parse(specsJson);
  var comp = aksharo_activeComp();
  if (comp === null || String(comp.id) !== String(compId)) {
    return aksharo_err("addTextLayers: comp " + compId + " is not the active item");
  }
  var layerIds = [];
  app.beginUndoGroup("Aksharo: add caption text layers");
  try {
    for (var i = 0; i < specs.length; i += 1) {
      var spec = specs[i];
      var layer = comp.layers.addText(spec.text);
      layer.startTime = spec.startSeconds;
      layer.outPoint = spec.startSeconds + spec.durationSeconds;
      layer.transform.position.setValue([spec.positionXPx, spec.positionYPx]);

      // GATE C: `TextDocument` property names below (font/fontSize/fillColor/strokeColor/
      // strokeWidth) match the documented object model
      // (https://ae-scripting.docsforadobe.dev/text/textdocument.html) but font-name resolution
      // (family string -> installed PostScript name) is unverified until a real AE install.
      var textProp = layer.property("Source Text");
      var doc = textProp.value;
      doc.font = spec.fontFamily;
      doc.fontSize = spec.fontSizePx;
      doc.fillColor = [spec.colorRgb[0] / 255, spec.colorRgb[1] / 255, spec.colorRgb[2] / 255];
      if (spec.strokeColorRgb) {
        doc.strokeColor = [
          spec.strokeColorRgb[0] / 255,
          spec.strokeColorRgb[1] / 255,
          spec.strokeColorRgb[2] / 255,
        ];
        doc.strokeWidth = spec.strokeWidthPx || 0;
        doc.applyStroke = true;
      }
      textProp.setValue(doc);

      // GATE C: `sourceRectAtTime` is documented
      // (https://ae-scripting.docsforadobe.dev/layers/layer.html#layer-sourcerectattime) but its
      // exact return shape for a just-created text layer (before AE has run a full frame update)
      // is unverified until a real AE install confirms it.
      if (spec.box) {
        var rect = layer.sourceRectAtTime(spec.startSeconds, false);
        var pad = spec.box.paddingPx || 0;
        var solid = comp.layers.addSolid(
          [spec.box.fillRgb[0] / 255, spec.box.fillRgb[1] / 255, spec.box.fillRgb[2] / 255],
          "Aksharo caption box",
          rect.width + pad * 2,
          rect.height + pad * 2,
          comp.pixelAspect,
          spec.durationSeconds
        );
        solid.startTime = spec.startSeconds;
        solid.outPoint = spec.startSeconds + spec.durationSeconds;
        solid.transform.position.setValue([
          spec.positionXPx + rect.left + rect.width / 2,
          spec.positionYPx + rect.top + rect.height / 2,
        ]);
        solid.transform.opacity.setValue(spec.box.opacity * 100);
        solid.moveAfter(layer);
      }

      layerIds.push(String(layer.index));
    }
  } finally {
    app.endUndoGroup();
  }
  return aksharo_ok({ layerIds: layerIds });
};

// --- importOverlay (unsupported/approximate style fallback, A20) -----------------------------

$.aksharo.importOverlay = function (sourcePath, compId) {
  try {
    var comp = aksharo_activeComp();
    if (comp === null || String(comp.id) !== String(compId)) {
      return aksharo_err("importOverlay: comp " + compId + " is not the active item");
    }
    var importOptions = new ImportOptions(new File(sourcePath));
    var footageItem = app.project.importFile(importOptions);
    var layer = comp.layers.add(footageItem);
    return aksharo_ok({ layerId: String(layer.index) });
  } catch (e) {
    return aksharo_err(e);
  }
};

// --- tagLayer (host-id map via marker comment, brief item 1) --------------------------------

$.aksharo.tagLayer = function (compId, layerIndex, metadataJson) {
  try {
    var comp = aksharo_activeComp();
    if (comp === null || String(comp.id) !== String(compId)) {
      return aksharo_err("tagLayer: comp " + compId + " is not the active item");
    }
    var layer = comp.layer(Number(layerIndex));
    var markerProp = layer.property("Marker");
    var marker = new MarkerValue(metadataJson);
    // GATE C: AVLayer marker streams support multiple keyframed markers; this always writes
    // at the layer's own start time (index 0 marker) since one tag per layer is all the brief
    // needs. Replacing an existing tag (idempotent re-apply) removes any prior marker first.
    if (markerProp.numKeys > 0) {
      markerProp.removeKey(1);
    }
    markerProp.setValueAtTime(layer.startTime, marker);
    return aksharo_ok(true);
  } catch (e) {
    return aksharo_err(e);
  }
};

$.aksharo.getLayerMetadata = function (compId, layerIndex) {
  try {
    var comp = aksharo_activeComp();
    if (comp === null || String(comp.id) !== String(compId)) {
      return aksharo_err("getLayerMetadata: comp " + compId + " is not the active item");
    }
    var layer = comp.layer(Number(layerIndex));
    var markerProp = layer.property("Marker");
    if (markerProp.numKeys === 0) {
      return aksharo_ok(null);
    }
    var marker = markerProp.keyValue(1);
    return aksharo_ok(JSON.parse(marker.comment));
  } catch (e) {
    return aksharo_err(e);
  }
};
