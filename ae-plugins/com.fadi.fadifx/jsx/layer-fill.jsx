/* fadiFX — static swatch fills. ExtendScript ES3; no timeline/keyframe edits. */

function fadiFX_fillSelection() {
	var comp = app.project.activeItem;
	if (!comp || !(comp instanceof CompItem))
		throw Error("No active composition");
	var layers = [],
		selected = comp.selectedLayers;
	for (var i = 0; i < selected.length; i++) layers.push(selected[i]);
	layers.sort(function (a, b) {
		return a.index - b.index;
	});
	return { comp: comp, layers: layers };
}

function fadiFX_fillColors(settings) {
	if (
		!settings ||
		(settings.mode !== "single" && settings.mode !== "ordered")
	) {
		throw Error("Choose a single or ordered fill");
	}
	var colors = settings.colors;
	if (!(colors instanceof Array) || colors.length < 1 || colors.length > 32) {
		throw Error("Choose between 1 and 32 colors");
	}
	var rgb = [];
	for (var i = 0; i < colors.length; i++) {
		if (typeof colors[i] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(colors[i])) {
			throw Error("Invalid color: use #RRGGBB");
		}
		rgb.push([
			parseInt(colors[i].substring(1, 3), 16) / 255,
			parseInt(colors[i].substring(3, 5), 16) / 255,
			parseInt(colors[i].substring(5, 7), 16) / 255,
		]);
	}
	return rgb;
}

function fadiFX_fillTarget(layer) {
	if (layer.locked)
		throw Error('Unlock "' + layer.name + '" before applying a fill');
	if (layer.hasVideo !== true || layer.nullLayer === true) {
		throw Error('"' + layer.name + '" is not a visual layer');
	}
	var effects = layer.property("ADBE Effect Parade");
	if (!effects || !effects.canAddProperty("ADBE Fill")) {
		throw Error('"' + layer.name + '" does not support Fill');
	}
	var ownIndex = 0;
	for (var i = 1; i <= effects.numProperties; i++) {
		var effect = effects.property(i);
		if (
			effect.name !== "fadiFX Swatch Fill" ||
			effect.matchName !== "ADBE Fill"
		)
			continue;
		if (ownIndex)
			throw Error(
				'"' + layer.name + '" has multiple fadiFX Swatch Fill effects',
			);
		var color = effect.property("ADBE Fill-0002");
		var opacity = effect.property("ADBE Fill-0005");
		if (!color)
			throw Error('Fill color is unavailable on "' + layer.name + '"');
		if (
			color.numKeys > 0 ||
			color.expressionEnabled ||
			(color.expression && color.expression.length)
		) {
			throw Error(
				'"' +
					layer.name +
					'" has an animated or expression-driven Swatch Fill; preserve or rename it first',
			);
		}
		if (
			!opacity ||
			opacity.numKeys > 0 ||
			opacity.expressionEnabled ||
			(opacity.expression && opacity.expression.length)
		) {
			throw Error(
				'"' +
					layer.name +
					'" has animated or expression-driven Swatch Fill opacity; preserve or rename it first',
			);
		}
		ownIndex = i;
	}
	return { layer: layer, effectIndex: ownIndex };
}

function fadiFX_applyLayerFill(settingsJSON) {
	var undoStarted = false;
	try {
		// The panel supplies controlled JSON, as in the existing animation host.
		var settings = eval("(" + settingsJSON + ")");
		var colors = fadiFX_fillColors(settings);
		var selection = fadiFX_fillSelection(),
			targets = [];
		if (!selection.layers.length) throw Error("No layers selected");
		// Validate the entire selection before changing any layer.
		for (var i = 0; i < selection.layers.length; i++) {
			targets.push(fadiFX_fillTarget(selection.layers[i]));
		}
		app.beginUndoGroup("fadiFX Swatch Fill");
		undoStarted = true;
		for (var t = 0; t < targets.length; t++) {
			var target = targets[t];
			var effects = target.layer.property("ADBE Effect Parade");
			var effect = target.effectIndex
				? effects.property(target.effectIndex)
				: effects.addProperty("ADBE Fill");
			if (!target.effectIndex) effect.name = "fadiFX Swatch Fill";
			effect.enabled = true;
			effect.property("ADBE Fill-0005").setValue(1);
			effect
				.property("ADBE Fill-0002")
				.setValue(colors[settings.mode === "single" ? 0 : t % colors.length]);
		}
		return (
			"Applied " +
			(settings.mode === "ordered" ? "ordered fills" : "fill") +
			" to " +
			targets.length +
			" layer(s)"
		);
	} catch (e) {
		return (
			"ERROR: " +
			(e.message || e.toString()) +
			(undoStarted ? ". Undo fadiFX Swatch Fill to revert this action." : "")
		);
	} finally {
		if (undoStarted) app.endUndoGroup();
	}
}

function fadiFX_fillQuote(value) {
	return (
		'"' +
		String(value).replace(/[\\"\x00-\x1f\u2028\u2029]/g, function (character) {
			if (character === '"' || character === "\\") return "\\" + character;
			return "\\u" + ("0000" + character.charCodeAt(0).toString(16)).slice(-4);
		}) +
		'"'
	);
}

function fadiFX_getLayerFillTargets() {
	try {
		var selection = fadiFX_fillSelection(),
			layers = [];
		for (var i = 0; i < selection.layers.length; i++) {
			var layer = selection.layers[i];
			layers.push(
				'{"id":' +
					(typeof layer.id === "number" ? layer.id : "null") +
					',"name":' +
					fadiFX_fillQuote(layer.name) +
					',"index":' +
					layer.index +
					"}",
			);
		}
		return (
			'{"compId":' +
			selection.comp.id +
			',"name":' +
			fadiFX_fillQuote(selection.comp.name) +
			',"count":' +
			layers.length +
			',"layers":[' +
			layers.join(",") +
			"]}"
		);
	} catch (e) {
		return "ERROR: " + (e.message || e.toString());
	}
}
