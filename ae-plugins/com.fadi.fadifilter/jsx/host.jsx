/* Fadi Filter: editable native effects, one AE undo group. */
function fadiFilter_context() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) throw Error("Open a composition");
    if (!comp.selectedLayers.length) throw Error("Select at least one footage layer");
    return comp;
}

function fadiFilter_histogram() {
    var probe;
    try {
        var comp = fadiFilter_context();
        var target = comp.selectedLayers[0];
        if (!(target instanceof AVLayer) || !target.hasVideo) throw Error("Select a visible footage layer");
        probe = comp.layers.addText("");
        var prop = probe.property("ADBE Text Properties").property("ADBE Text Document");
        prop.expression = [
            "var target = thisComp.layer(" + target.index + ");",
            "var bins = [], cols = 32, rows = 24;",
            "for (var i=0; i<256; i++) bins[i]=0;",
            "for (var y=0; y<rows; y++) for(var x=0; x<cols; x++) {",
            "  var pixel=target.sampleImage([(x+.5)*target.width/cols,(y+.5)*target.height/rows],[.5,.5],true,time);",
            "  if(pixel[3]>.5) bins[Math.max(0,Math.min(255,Math.round(255*(.299*pixel[0]+.587*pixel[1]+.114*pixel[2]))))]++;",
            "}",
            "bins.join(',');"
        ].join("\n");
        var histogram = prop.valueAtTime(comp.time, false).text;
        if (prop.expressionError) throw Error(prop.expressionError);
        if (histogram.split(",").length !== 256) throw Error("After Effects did not return a tonal sample");
        return histogram;
    } catch (e) { return "ERROR: " + e.toString(); }
    finally { if (probe) probe.remove(); }
}

function fadiFilter_tint(layer, hex) {
    var effect = layer.property("ADBE Effect Parade").addProperty("ADBE Tint");
    var rgb = [parseInt(hex.substr(1, 2), 16) / 255, parseInt(hex.substr(3, 2), 16) / 255,
        parseInt(hex.substr(5, 2), 16) / 255];
    effect.name = "Fadi Filter Color";
    effect.property(1).setValue(rgb);
    effect.property(2).setValue(rgb);
    effect.property(3).setValue(100);
}

function fadiFilter_extract(layer, lo, hi, softness) {
    var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Extract");
    fx.name = "Fadi Filter Luma";
    fx.property("Black Point").setValue(Math.round(lo * 255));
    fx.property("White Point").setValue(Math.round(hi * 255));
    fx.property("Black Softness").setValue(Math.round(softness * 255));
    fx.property("White Softness").setValue(0);
}

function fadiFilter_apply(cuts, colors, softness, method) {
    var added = [], begun = false, i, j;
    try {
        var comp = fadiFilter_context();
        var layers = comp.selectedLayers;
        if (colors.length < 2 || colors.length > 8 || cuts.length !== colors.length - 1 ||
            softness < 0 || softness > 0.25) throw Error("Invalid band settings");
        for (i = 0; i < colors.length; i++) if (!/^#[0-9a-f]{6}$/i.test(colors[i])) throw Error("Invalid color");
        for (i = 0; i < cuts.length; i++)
            if (!(cuts[i] > 0 && cuts[i] < 1) || (i && cuts[i] <= cuts[i - 1])) throw Error("Invalid boundary");
        for (i = 0; i < layers.length; i++) {
            if (!(layers[i] instanceof AVLayer) || !layers[i].source || layers[i].adjustmentLayer ||
                layers[i].locked || !layers[i].hasVideo)
                throw Error("Choose unlocked footage, solid, or precomp layers");
        }
        app.beginUndoGroup("Fadi Filter");
        begun = true;
        for (i = 0; i < layers.length; i++) {
            var source = layers[i];
            var previous = source;
            for (j = 0; j < colors.length; j++) {
                var band = source.duplicate();
                added.push(band);
                band.moveBefore(previous);
                previous = band;
                band.name = "Fadi Filter " + method + " | " + (j + 1) + " | " + source.name;
                band.audioEnabled = false;
                if (j) fadiFilter_extract(band, cuts[j - 1], 1, softness);
                fadiFilter_tint(band, colors[j]);
            }
            if (method === "M7") {
                var edge = source.duplicate();
                added.push(edge);
                edge.moveBefore(previous);
                edge.name = "Fadi Filter M7 | Ink contour | " + source.name;
                edge.audioEnabled = false;
                edge.property("ADBE Effect Parade").addProperty("ADBE Find Edges");
                fadiFilter_extract(edge, 0, 0.45, 0);
                fadiFilter_tint(edge, colors[0]);
            }
        }
        return "Applied " + method + " to " + layers.length + " layer(s)";
    } catch (e) {
        for (i = added.length - 1; i >= 0; i--) try { added[i].remove(); } catch (ignored) {}
        return "ERROR: " + e.toString() + " (line " + e.line + ")";
    } finally {
        if (begun) app.endUndoGroup();
    }
}
