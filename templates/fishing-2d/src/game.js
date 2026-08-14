/* Lucky Lake Fishing — mobile-first Phaser 3 fishing game.
   Tap to cast, wait for the bite, tap during the bite window to catch.
   Reach the target score before the timer ends. */
(function () {
  "use strict";

  var W = 402, H = 874;
  var GAME_SECONDS = 60;
  var TARGET_SCORE = 30;

  var FISH = [
    { name: "Minnow", points: 2, color: 0x9ad1d4, rarity: 0.5 },
    { name: "Bass", points: 5, color: 0x80ed99, rarity: 0.3 },
    { name: "Salmon", points: 8, color: 0xf28482, rarity: 0.15 },
    { name: "Golden Koi", points: 15, color: 0xffd166, rarity: 0.05 }
  ];

  function pickFish() {
    var r = Math.random(), acc = 0;
    for (var i = 0; i < FISH.length; i++) {
      acc += FISH[i].rarity;
      if (r <= acc) return FISH[i];
    }
    return FISH[0];
  }

  var PlayScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function PlayScene() {
      Phaser.Scene.call(this, { key: "Play" });
    },

    create: function () {
      var s = this;
      s.state = "idle"; // idle | casting | waiting | bite | caught | gameover
      s.score = 0;
      s.fishCaught = 0;
      s.timeLeft = GAME_SECONDS;
      s.won = false;

      // --- water & sky (procedural, no external assets) ---
      var sky = s.add.graphics();
      sky.fillGradientStyle(0x0b5d8a, 0x0b5d8a, 0x06283d, 0x06283d, 1);
      sky.fillRect(0, 0, W, H);
      s.waves = [];
      for (var i = 0; i < 7; i++) {
        var wave = s.add.ellipse(Math.random() * W, 330 + i * 70, 130 + Math.random() * 90, 10, 0x1d7ba8, 0.35);
        s.waves.push(wave);
      }
      // boat + angler
      s.add.ellipse(W / 2, 260, 170, 42, 0x8a5a44);
      s.add.rectangle(W / 2, 236, 12, 44, 0x6f4533);
      s.add.circle(W / 2, 206, 14, 0xf2cc8f);

      // fishing line + bob
      s.line = s.add.line(0, 0, W / 2 + 6, 240, W / 2 + 6, 240, 0xffffff, 0.9).setOrigin(0);
      s.bob = s.add.circle(W / 2 + 6, 250, 9, 0xef476f).setVisible(false);
      s.splash = s.add.circle(0, 0, 4, 0xffffff, 0.9).setVisible(false);

      // --- HUD (large, readable, thumb friendly) ---
      var hudStyle = { fontFamily: "system-ui, sans-serif", fontSize: "26px", color: "#ffffff" };
      s.scoreText = s.add.text(16, 18, "Score 0/" + TARGET_SCORE, hudStyle);
      s.timerText = s.add.text(W - 16, 18, GAME_SECONDS + "s", hudStyle).setOrigin(1, 0);
      s.hintText = s.add
        .text(W / 2, H - 140, "TAP TO CAST", { fontFamily: "system-ui, sans-serif", fontSize: "34px", color: "#ffd166", fontStyle: "bold" })
        .setOrigin(0.5);
      s.toastText = s.add
        .text(W / 2, 380, "", { fontFamily: "system-ui, sans-serif", fontSize: "28px", color: "#80ed99", fontStyle: "bold" })
        .setOrigin(0.5);

      // restart button (hidden until game over) — big touch target
      s.restartBg = s.add.rectangle(W / 2, H / 2 + 90, 260, 76, 0x238636).setVisible(false).setInteractive();
      s.restartText = s.add
        .text(W / 2, H / 2 + 90, "PLAY AGAIN", { fontFamily: "system-ui, sans-serif", fontSize: "30px", color: "#ffffff", fontStyle: "bold" })
        .setOrigin(0.5)
        .setVisible(false);
      s.bannerText = s.add
        .text(W / 2, H / 2 - 20, "", { fontFamily: "system-ui, sans-serif", fontSize: "44px", color: "#ffffff", fontStyle: "bold" })
        .setOrigin(0.5);
      s.restartBg.on("pointerdown", function () {
        s.scene.restart();
      });

      // --- input: single tap drives the whole loop ---
      s.input.on("pointerdown", function () {
        s.onTap();
      });
      s.input.keyboard.on("keydown-SPACE", function () {
        s.onTap();
      });

      // --- game timer ---
      s.time.addEvent({
        delay: 1000,
        loop: true,
        callback: function () {
          if (s.state === "gameover") return;
          s.timeLeft -= 1;
          s.timerText.setText(Math.max(0, s.timeLeft) + "s");
          if (s.timeLeft <= 0) s.endGame();
        }
      });

      s.updateTestHook();
    },

    onTap: function () {
      var s = this;
      if (s.state === "idle") {
        s.cast();
      } else if (s.state === "bite") {
        s.catchFish();
      } else if (s.state === "waiting") {
        // tapping too early scares the fish a little (restarts the wait)
        s.showToast("Too early…", "#f4a261");
        s.scheduleBite();
      }
    },

    cast: function () {
      var s = this;
      s.state = "casting";
      s.hintText.setText("CASTING…");
      var targetY = 460 + Math.random() * 220;
      s.bob.setVisible(true);
      s.tweens.add({
        targets: s.bob,
        y: targetY,
        duration: 500,
        ease: "Quad.easeIn",
        onUpdate: function () {
          s.line.setTo(W / 2 + 6, 240, s.bob.x, s.bob.y);
        },
        onComplete: function () {
          s.state = "waiting";
          s.hintText.setText("WAIT FOR THE BITE…");
          s.scheduleBite();
        }
      });
      s.updateTestHook();
    },

    scheduleBite: function () {
      var s = this;
      if (s.biteTimer) s.biteTimer.remove(false);
      s.biteTimer = s.time.delayedCall(700 + Math.random() * 1800, function () {
        if (s.state !== "waiting") return;
        s.state = "bite";
        s.pendingFish = pickFish();
        s.hintText.setText("!!! TAP NOW !!!");
        s.splash.setPosition(s.bob.x, s.bob.y).setVisible(true).setScale(1);
        s.tweens.add({ targets: s.splash, scale: 4, alpha: 0, duration: 500, onComplete: function () { s.splash.setVisible(false).setAlpha(0.9); } });
        s.tweens.add({ targets: s.bob, y: s.bob.y + 14, yoyo: true, repeat: 3, duration: 120 });
        // miss the window → fish escapes
        s.time.delayedCall(1400, function () {
          if (s.state === "bite") {
            s.state = "idle";
            s.bob.setVisible(false);
            s.line.setTo(W / 2 + 6, 240, W / 2 + 6, 240);
            s.showToast("It got away!", "#ef476f");
            s.hintText.setText("TAP TO CAST");
            s.updateTestHook();
          }
        });
        s.updateTestHook();
      });
    },

    catchFish: function () {
      var s = this;
      var fish = s.pendingFish || FISH[0];
      s.state = "caught";
      s.score += fish.points;
      s.fishCaught += 1;
      s.scoreText.setText("Score " + s.score + "/" + TARGET_SCORE);
      s.showToast("+" + fish.points + " " + fish.name + "!", "#80ed99");
      var f = s.add.ellipse(s.bob.x, s.bob.y, 40, 18, fish.color);
      s.tweens.add({ targets: f, y: 250, x: W / 2, alpha: 0, duration: 600, onComplete: function () { f.destroy(); } });
      s.bob.setVisible(false);
      s.line.setTo(W / 2 + 6, 240, W / 2 + 6, 240);
      s.time.delayedCall(500, function () {
        if (s.state !== "gameover") {
          s.state = "idle";
          s.hintText.setText("TAP TO CAST");
          s.updateTestHook();
        }
      });
      if (s.score >= TARGET_SCORE) s.endGame();
      s.updateTestHook();
    },

    endGame: function () {
      var s = this;
      s.won = s.score >= TARGET_SCORE;
      s.state = "gameover";
      s.hintText.setText("");
      s.bannerText.setText(s.won ? "YOU WIN! 🏆" : "TIME'S UP");
      s.restartBg.setVisible(true);
      s.restartText.setVisible(true);
      s.updateTestHook();
    },

    showToast: function (text, color) {
      var s = this;
      s.toastText.setText(text).setColor(color).setAlpha(1);
      s.tweens.add({ targets: s.toastText, alpha: 0, delay: 700, duration: 400 });
    },

    update: function (time) {
      var s = this;
      for (var i = 0; i < s.waves.length; i++) {
        s.waves[i].x += Math.sin(time / 900 + i) * 0.3;
      }
      s.updateTestHook();
    },

    updateTestHook: function () {
      // Development/QA hook — read-only game state, no dangerous capabilities.
      window.__PLAYLAP_TEST__ = {
        scene: "Play",
        state: this.state,
        score: this.score,
        fishCaught: this.fishCaught,
        timeLeft: this.timeLeft,
        targetScore: TARGET_SCORE,
        won: this.won
      };
    }
  });

  new Phaser.Game({
    type: Phaser.CANVAS,
    parent: "game",
    width: W,
    height: H,
    backgroundColor: "#06283d",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [PlayScene]
  });
})();
