const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function effect(name = "fadiFX Swatch Fill", options = {}) {
	const color = {
		value: [0, 0, 0],
		numKeys: options.numKeys || 0,
		expression: options.expression || "",
		expressionEnabled: !!options.expressionEnabled,
		setValue(value) {
			if (options.fail) throw Error("Cannot set color");
			this.value = Array.from(value);
		},
	};
	const opacity = {
		value: options.opacity === undefined ? 1 : options.opacity,
		numKeys: options.opacityKeys || 0,
		expression: options.opacityExpression || "",
		expressionEnabled: !!options.opacityExpressionEnabled,
		setValue(value) {
			this.value = value;
		},
	};
	return {
		name,
		enabled: options.enabled !== false,
		opacity,
		matchName: "ADBE Fill",
		color,
		property(key) {
			return key === "ADBE Fill-0002"
				? color
				: key === "ADBE Fill-0005"
					? opacity
					: null;
		},
	};
}

function layer(index, options = {}) {
	const effects = options.effects || [];
	const parade = {
		get numProperties() {
			return effects.length;
		},
		property(i) {
			return effects[i - 1];
		},
		canAddProperty() {
			return options.supported !== false;
		},
		addProperty() {
			if (options.failAdd) throw Error("Cannot add effect");
			const added = effect("Fill");
			effects.push(added);
			return added;
		},
	};
	return {
		id: 100 + index,
		index,
		name: "Layer " + index,
		hasVideo: options.hasVideo !== false,
		nullLayer: !!options.nullLayer,
		locked: !!options.locked,
		inPoint: 2,
		outPoint: 5,
		startTime: -1,
		stretch: 100,
		effects,
		property(key) {
			return key === "ADBE Effect Parade" ? parade : null;
		},
	};
}

function host(layers) {
	function CompItem() {}
	const comp = new CompItem();
	Object.assign(comp, {
		id: 7,
		name: 'Comp "City"\nSky\u2028',
		selectedLayers: layers,
	});
	const undo = [];
	const context = vm.createContext({
		CompItem,
		app: {
			project: { activeItem: comp },
			beginUndoGroup(name) {
				undo.push(["begin", name]);
			},
			endUndoGroup() {
				undo.push(["end"]);
			},
		},
	});
	vm.runInContext(
		fs.readFileSync(path.join(__dirname, "../jsx/layer-fill.jsx"), "utf8"),
		context,
	);
	return {
		context,
		comp,
		undo,
		apply(settings) {
			return context.fadiFX_applyLayerFill(JSON.stringify(settings));
		},
	};
}

test("ordered colors follow top-to-bottom layer order and wrap", () => {
	const layers = [layer(5), layer(1), layer(3)];
	const h = host(layers);
	assert.match(
		h.apply({ mode: "ordered", colors: ["#FF0000", "#00FF00"] }),
		/3 layer/,
	);
	assert.deepEqual(
		layers.map((l) => l.effects[0].color.value),
		[
			[1, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
		],
	);
	assert.deepEqual(
		layers.map((l) => l.index),
		[5, 1, 3],
	);
	assert.deepEqual(h.undo, [["begin", "fadiFX Swatch Fill"], ["end"]]);
});

test("single color applies exactly to all selected layers without changing timing", () => {
	const layers = [layer(1), layer(2)];
	const h = host(layers);
	assert.match(h.apply({ mode: "single", colors: ["#1280aF"] }), /2 layer/);
	for (const l of layers) {
		assert.deepEqual(l.effects[0].color.value, [
			18 / 255,
			128 / 255,
			175 / 255,
		]);
		assert.equal(l.effects[0].color.numKeys, 0);
		assert.deepEqual(
			[l.inPoint, l.outPoint, l.startTime, l.stretch],
			[2, 5, -1, 100],
		);
	}
});

test("updates its own static fill while preserving unrelated and older animated fills", () => {
	const original = effect("Fill", { numKeys: 2 });
	const animated = effect("fadiFX Fill", { numKeys: 5 });
	const owned = effect();
	const l = layer(1, { effects: [original, animated, owned] });
	const h = host([l]);
	assert.match(h.apply({ mode: "single", colors: ["#FFFFFF"] }), /1 layer/);
	assert.deepEqual(l.effects, [original, animated, owned]);
	assert.deepEqual(original.color.value, [0, 0, 0]);
	assert.equal(animated.color.numKeys, 5);
	assert.deepEqual(owned.color.value, [1, 1, 1]);
});

test("invalid settings reject before any mutation or undo group", () => {
	for (const settings of [
		null,
		{},
		{ mode: "other", colors: ["#000000"] },
		{ mode: "single", colors: [] },
		{ mode: "ordered", colors: ["#fff"] },
		{ mode: "single", colors: ["#FFFFFF", "#FFFFFG"] },
		{ mode: "single", colors: Array(33).fill("#000000") },
		{ mode: "single", colors: { 0: "#FFFFFF", length: 1 } },
	]) {
		const l = layer(1),
			h = host([l]);
		assert.match(h.apply(settings), /^ERROR:/);
		assert.equal(l.effects.length, 0);
		assert.deepEqual(h.undo, []);
	}
});

test("preflights every layer including locked, audio, null, and unsupported targets", () => {
	for (const options of [
		{ locked: true },
		{ hasVideo: false },
		{ nullLayer: true },
		{ supported: false },
	]) {
		const first = layer(1),
			invalid = layer(2, options),
			h = host([first, invalid]);
		assert.match(h.apply({ mode: "single", colors: ["#123456"] }), /^ERROR:/);
		assert.equal(first.effects.length, 0);
		assert.equal(invalid.effects.length, 0);
		assert.deepEqual(h.undo, []);
	}
});

test("existing owned animation and expressions reject the whole action", () => {
	for (const options of [
		{ numKeys: 1 },
		{ expression: "wiggle(1, 1)" },
		{ expressionEnabled: true },
	]) {
		const first = layer(1),
			animated = effect(undefined, options);
		const h = host([first, layer(2, { effects: [animated] })]);
		assert.match(
			h.apply({ mode: "single", colors: ["#123456"] }),
			/ERROR:.*animat|ERROR:.*expression/i,
		);
		assert.equal(first.effects.length, 0);
		assert.deepEqual(animated.color.value, [0, 0, 0]);
		assert.deepEqual(h.undo, []);
	}
});

test("ends the one undo group on an unexpected host mutation failure", () => {
	for (const options of [
		{ failAdd: true },
		{ effects: [effect(undefined, { fail: true })] },
	]) {
		const h = host([layer(1, options)]);
		assert.match(h.apply({ mode: "single", colors: ["#FFFFFF"] }), /^ERROR:/);
		assert.deepEqual(h.undo, [["begin", "fadiFX Swatch Fill"], ["end"]]);
	}
});

test("reports sorted target identities with valid escaped JSON", () => {
	const a = layer(5),
		b = layer(1);
	a.name = 'Clip \\ "\t\u0001';
	const h = host([a, b]);
	const result = JSON.parse(h.context.fadiFX_getLayerFillTargets());
	assert.deepEqual(result, {
		compId: 7,
		name: h.comp.name,
		count: 2,
		layers: [
			{ id: 101, name: b.name, index: 1 },
			{ id: 105, name: a.name, index: 5 },
		],
	});
	assert.equal(a.effects.length, 0);
	assert.deepEqual(h.undo, []);
});

test("handles no selection and no active composition explicitly", () => {
	const h = host([]);
	assert.match(
		h.apply({ mode: "single", colors: ["#FFFFFF"] }),
		/^ERROR: No layers selected/,
	);
	assert.equal(JSON.parse(h.context.fadiFX_getLayerFillTargets()).count, 0);
	h.context.app.project.activeItem = null;
	assert.match(
		h.apply({ mode: "single", colors: ["#FFFFFF"] }),
		/^ERROR: No active composition/,
	);
	assert.match(
		h.context.fadiFX_getLayerFillTargets(),
		/^ERROR: No active composition/,
	);
});

test("restores an owned disabled or transparent static Fill", () => {
	const owned = effect(undefined, { enabled: false, opacity: 0 });
	const h = host([layer(1, { effects: [owned] })]);
	assert.match(h.apply({ mode: "single", colors: ["#FF0060"] }), /1 layer/);
	assert.equal(owned.enabled, true);
	assert.equal(owned.opacity.value, 1);
});

test("protects animated owned opacity and rejects duplicate owned fills before mutation", () => {
	for (const effects of [
		[effect(undefined, { opacityKeys: 1 })],
		[effect(undefined, { opacityExpression: "wiggle(1,1)" })],
		[effect(undefined, { opacityExpressionEnabled: true })],
		[effect(), effect()],
	]) {
		const first = layer(1),
			h = host([first, layer(2, { effects })]);
		assert.match(h.apply({ mode: "single", colors: ["#FFFFFF"] }), /^ERROR:/);
		assert.equal(first.effects.length, 0);
		assert.deepEqual(h.undo, []);
	}
});
