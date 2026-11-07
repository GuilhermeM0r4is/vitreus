//! Scene data model. Mirrors the shape of the JS prototype's `state` object
//! so campaigns saved by one can map cleanly onto the other conceptually.
//! This is what gets persisted to disk (as JSON) per campaign.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Wall {
    pub a: Point,
    pub b: Point,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Token {
    pub id: String,
    pub kind: String, // "circle" | "tri" | "img"
    pub asset_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub facing: f64,
    pub light_facing: f64,
    pub follow_token: bool,
    pub cone: f64,
    pub light: bool,
    pub light_offset: Point,
    pub locked: bool,
    pub flip: bool,
    #[serde(default)]
    pub layer: RenderLayer,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LightPoint {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub on: bool,
    pub color: String,
    pub intensity: f64,
    pub radius: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MapObject {
    pub id: String,
    pub asset_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rotation: f64,
    pub locked: bool,
    #[serde(default = "default_map_layer")]
    pub layer: RenderLayer,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RenderLayer {
    Back,
    Normal,
    Front,
}

impl Default for RenderLayer {
    fn default() -> Self {
        Self::Normal
    }
}

fn default_map_layer() -> RenderLayer {
    RenderLayer::Back
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Scene {
    pub tokens: Vec<Token>,
    pub walls: Vec<Wall>,
    pub lights: Vec<LightPoint>,
    pub map_objects: Vec<MapObject>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Campaign {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AssetFolder {
    pub id: String,
    pub color: String,
}

/// Everything that isn't the active scene: campaign list, folders, and
/// the asset library (imported token/map images, audio tracks). Asset
/// *files* live on disk under the app data dir; this just indexes them.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Library {
    pub campaigns: Vec<Campaign>,
    pub current_campaign: Option<String>,
    pub token_folders: Vec<AssetFolder>,
    pub map_folders: Vec<AssetFolder>,
    /// asset id -> (folder_id, file name on disk under assets/)
    pub token_assets: HashMap<String, (String, String)>,
    pub map_assets: HashMap<String, (String, String)>,
    pub tracks: Vec<(String, String)>, // (id, file name)
}

impl Default for AssetFolder {
    fn default() -> Self {
        AssetFolder {
            id: "root".into(),
            color: "#ffb3b3".into(),
        }
    }
}
