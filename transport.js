/***********************
 * Transport Layer    *
 * Provides HueAPI and MockHueAPI in the browser.
 * Expects global AppState, GroupManager, scheduleRender to exist when invoked.
 ***********************/
(function() {
  const MockHueAPI = {
    _mockLights: {
      "1": { name: "Mock Front Left", state: { on: true, bri: 200, hue: 10000, sat: 200, ct: 300 } },
      "2": { name: "Mock Front Right", state: { on: true, bri: 180, hue: 50000, sat: 180, ct: 250 } },
      "3": { name: "Mock Back Wash", state: { on: false, bri: 254, hue: 30000, sat: 254, ct: 200 } },
      "4": { name: "Mock Center Spot", state: { on: true, bri: 220, hue: 45000, sat: 210, ct: 180 } },
      "5": { name: "Mock Side Fill L", state: { on: true, bri: 160, hue: 15000, sat: 150, ct: 260 } },
      "6": { name: "Mock Side Fill R", state: { on: true, bri: 160, hue: 55000, sat: 150, ct: 260 } }
    },
    authenticate: async function() {
      AppState.username = "mock-user";
      AppState.dom.authStatus.innerText = "Authenticated to mock bridge.";
      return { success: true };
    },
    discoverLights: async function() {
      AppState.discoveredLights = JSON.parse(JSON.stringify(this._mockLights));
      AppState.dom.discoverStatus.innerText = "Mock lights loaded.";
      GroupManager.reconcileGroupLights();
      scheduleRender();
      return AppState.discoveredLights;
    },
    refreshLightStatus: async function() {
      return this.discoverLights();
    },
    updateLightState: async function(lightId, state) {
      if (!AppState.discoveredLights[lightId]) return;
      AppState.discoveredLights[lightId].state = {
        ...AppState.discoveredLights[lightId].state,
        ...state
      };
      return [{ success: true }];
    }
  };

  const HueAPI = {
    apiRequest: async function(url, method = 'GET', body = null) {
      const options = { method };
      if (body) options.body = body;
      const response = await fetch(url, options);
      return response.json();
    },
    authenticate: async function() {
      if (AppState.useMock) {
        return MockHueAPI.authenticate();
      }
      AppState.bridgeIP = AppState.dom.bridgeInput.value.trim();
      if (!AppState.bridgeIP) { alert("Please enter the Hue Bridge IP address."); return; }
      localStorage.setItem('hueBridgeIP', AppState.bridgeIP);
      const url = `http://${AppState.bridgeIP}/api`;
      const body = JSON.stringify({ devicetype: "hue_control_prototype#web" });
      try {
        const data = await this.apiRequest(url, 'POST', body);
        console.log("Authentication response:", data);
        const result = data[0];
        if (result && result.success && result.success.username) {
          AppState.username = result.success.username;
          localStorage.setItem('hueUsername', AppState.username);
          AppState.dom.authStatus.innerText = "Authenticated successfully!";
          this.discoverLights();
        } else if (result && result.error) {
          AppState.dom.authStatus.innerText = "Error: " + result.error.description;
        }
      } catch (err) {
        console.error("Authentication error:", err);
        AppState.dom.authStatus.innerText = "Authentication failed.";
      }
    },
    discoverLights: async function() {
      if (AppState.useMock) {
        return MockHueAPI.discoverLights();
      }
      if (!AppState.bridgeIP || !AppState.username) { alert("Please authenticate first."); return; }
      const url = `http://${AppState.bridgeIP}/api/${AppState.username}/lights`;
      try {
        const lights = await this.apiRequest(url, 'GET');
        console.log("Discovered lights:", lights);
        AppState.dom.discoverStatus.innerText = "Lights discovered.";
        AppState.discoveredLights = lights;
        GroupManager.reconcileGroupLights();
        scheduleRender();
      } catch (err) {
        console.error("Error discovering lights:", err);
        AppState.dom.discoverStatus.innerText = "Error discovering lights.";
      }
    },
    refreshLightStatus: async function() {
      if (AppState.useMock) {
        return MockHueAPI.refreshLightStatus();
      }
      if (!AppState.bridgeIP || !AppState.username) { alert("Please authenticate first."); return; }
      const url = `http://${AppState.bridgeIP}/api/${AppState.username}/lights`;
      try {
        const lights = await this.apiRequest(url, 'GET');
        console.log("Refreshed lights:", lights);
        if (!AppState.dom.autoRefreshUnassigned.checked) {
          const unassigned = AppState.groups.find(g => g.id === "group-unassigned");
          if (unassigned) {
            unassigned.lights.forEach(lightId => {
              if (AppState.discoveredLights[lightId]) lights[lightId] = AppState.discoveredLights[lightId];
            });
          }
        }
        AppState.discoveredLights = lights;
        scheduleRender();
      } catch (err) {
        console.error("Error refreshing light status:", err);
      }
    },
    updateLightState: async function(lightId, state) {
      if (AppState.useMock) {
        return MockHueAPI.updateLightState(lightId, state);
      }
      if (!AppState.bridgeIP || !AppState.username) { alert("Please authenticate first."); return; }
      const url = `http://${AppState.bridgeIP}/api/${AppState.username}/lights/${lightId}/state`;
      try {
        const result = await this.apiRequest(url, 'PUT', JSON.stringify(state));
        console.log(`Update result for light ${lightId}:`, result);
      } catch (error) {
        console.error(`Error updating light ${lightId}:`, error);
      }
    }
  };

  // expose globally
  window.MockHueAPI = MockHueAPI;
  window.HueAPI = HueAPI;
})();
