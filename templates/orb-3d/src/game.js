/* Orb Runner 3D — mobile-first Babylon.js collector.
   Tap the ground (or use arrow keys) to roll the player sphere; collect all
   glowing orbs before the timer runs out. */
(function () {
  "use strict";

  var TOTAL_ORBS = 8;
  var GAME_SECONDS = 45;
  var ARENA = 14;

  var canvas = document.getElementById("renderCanvas");
  var engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false, disableWebGL2Support: false });

  var state = {};

  function buildScene() {
    var scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.04, 0.06, 0.12, 1);

    var camera = new BABYLON.ArcRotateCamera("cam", -Math.PI / 2, 1.05, 24, BABYLON.Vector3.Zero(), scene);
    camera.lowerRadiusLimit = camera.upperRadiusLimit = 24; // fixed framing, mobile friendly
    var light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0.3, 1, 0.2), scene);
    light.intensity = 1.1;

    var ground = BABYLON.MeshBuilder.CreateGround("ground", { width: ARENA * 2, height: ARENA * 2 }, scene);
    var gmat = new BABYLON.StandardMaterial("gmat", scene);
    gmat.diffuseColor = new BABYLON.Color3(0.09, 0.16, 0.28);
    gmat.specularColor = BABYLON.Color3.Black();
    ground.material = gmat;

    var player = BABYLON.MeshBuilder.CreateSphere("player", { diameter: 1.6, segments: 12 }, scene);
    player.position.y = 0.8;
    var pmat = new BABYLON.StandardMaterial("pmat", scene);
    pmat.diffuseColor = new BABYLON.Color3(0.95, 0.55, 0.15);
    pmat.emissiveColor = new BABYLON.Color3(0.35, 0.18, 0.02);
    player.material = pmat;

    var orbs = [];
    for (var i = 0; i < TOTAL_ORBS; i++) {
      var orb = BABYLON.MeshBuilder.CreateSphere("orb" + i, { diameter: 0.9, segments: 10 }, scene);
      var a = (i / TOTAL_ORBS) * Math.PI * 2;
      var r = 4 + (i % 3) * 3.2;
      orb.position.set(Math.cos(a) * r, 0.7, Math.sin(a) * r);
      var omat = new BABYLON.StandardMaterial("omat" + i, scene);
      omat.emissiveColor = new BABYLON.Color3(0.2, 0.85, 0.9);
      omat.diffuseColor = new BABYLON.Color3(0.1, 0.4, 0.5);
      orb.material = omat;
      orbs.push(orb);
    }

    state = {
      scene: scene,
      player: player,
      orbs: orbs,
      target: null,
      collected: 0,
      timeLeft: GAME_SECONDS,
      phase: "playing", // playing | won | lost
      keys: {}
    };

    // --- touch/pointer: roll toward tapped ground point ---
    scene.onPointerObservable.add(function (info) {
      if (info.type !== BABYLON.PointerEventTypes.POINTERDOWN || state.phase !== "playing") return;
      var pick = scene.pick(scene.pointerX, scene.pointerY, function (m) { return m === ground; });
      if (pick && pick.hit && pick.pickedPoint) {
        state.target = new BABYLON.Vector3(pick.pickedPoint.x, 0.8, pick.pickedPoint.z);
      }
    });

    // --- keyboard fallback ---
    window.addEventListener("keydown", function (e) { state.keys[e.key] = true; });
    window.addEventListener("keyup", function (e) { state.keys[e.key] = false; });

    scene.onBeforeRenderObservable.add(function () {
      if (state.phase !== "playing") return;
      var dt = engine.getDeltaTime() / 1000;
      var speed = 9;
      var p = player.position;
      var moved = false;
      if (state.keys.ArrowUp) { p.z -= speed * dt; moved = true; }
      if (state.keys.ArrowDown) { p.z += speed * dt; moved = true; }
      if (state.keys.ArrowLeft) { p.x -= speed * dt; moved = true; }
      if (state.keys.ArrowRight) { p.x += speed * dt; moved = true; }
      if (!moved && state.target) {
        var dir = state.target.subtract(p);
        dir.y = 0;
        var dist = dir.length();
        if (dist > 0.2) {
          dir.normalize();
          p.addInPlace(dir.scale(Math.min(speed * dt, dist)));
          player.rotate(BABYLON.Axis.X, speed * dt * 0.5, BABYLON.Space.WORLD);
        } else {
          state.target = null;
        }
      }
      p.x = Math.max(-ARENA + 1, Math.min(ARENA - 1, p.x));
      p.z = Math.max(-ARENA + 1, Math.min(ARENA - 1, p.z));

      for (var i = state.orbs.length - 1; i >= 0; i--) {
        var orb = state.orbs[i];
        orb.rotation.y += dt * 2;
        orb.position.y = 0.7 + Math.sin(performance.now() / 400 + i) * 0.15;
        if (BABYLON.Vector3.Distance(orb.position, p) < 1.4) {
          orb.dispose();
          state.orbs.splice(i, 1);
          state.collected += 1;
          updateHud();
          if (state.collected >= TOTAL_ORBS) endGame(true);
        }
      }
      updateTestHook();
    });

    return scene;
  }

  function updateHud() {
    document.getElementById("score").textContent = "Orbs " + state.collected + "/" + TOTAL_ORBS;
    document.getElementById("timer").textContent = Math.max(0, Math.ceil(state.timeLeft)) + "s";
  }

  function endGame(won) {
    state.phase = won ? "won" : "lost";
    document.getElementById("bannerText").textContent = won ? "YOU WIN! 🏆" : "TIME'S UP";
    document.getElementById("banner").style.display = "flex";
    updateTestHook();
  }

  function updateTestHook() {
    // Development/QA hook — read-only game state, no dangerous capabilities.
    window.__PLAYLAP_TEST__ = {
      scene: "main",
      state: state.phase,
      score: state.collected,
      orbsRemaining: state.orbs ? state.orbs.length : TOTAL_ORBS,
      timeLeft: Math.max(0, Math.round(state.timeLeft)),
      player: state.player ? { x: +state.player.position.x.toFixed(2), z: +state.player.position.z.toFixed(2) } : null,
      won: state.phase === "won"
    };
  }

  var scene = buildScene();
  updateHud();
  updateTestHook();

  setInterval(function () {
    if (state.phase !== "playing") return;
    state.timeLeft -= 1;
    updateHud();
    updateTestHook();
    if (state.timeLeft <= 0) endGame(false);
  }, 1000);

  document.getElementById("restart").addEventListener("click", function () {
    document.getElementById("banner").style.display = "none";
    scene.dispose();
    scene = buildScene();
    updateHud();
  });

  engine.runRenderLoop(function () {
    scene.render();
  });
  window.addEventListener("resize", function () {
    engine.resize();
  });
})();
