use crate::lighting::{self, Point as GeoPoint, Wall as GeoWall};
use crate::state::{AssetFolder, Campaign, Library, Scene, Wall};
use image::{imageops::FilterType, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub struct AppState {
    pub data_dir: PathBuf,
}

fn library_path(dir: &PathBuf) -> PathBuf {
    dir.join("library.json")
}
fn scene_path(dir: &PathBuf, campaign_id: &str) -> PathBuf {
    dir.join(format!("campaign-{campaign_id}.json"))
}
fn default_scene_path(dir: &PathBuf) -> PathBuf {
    dir.join("campaign-default.json")
}
fn assets_dir(dir: &PathBuf) -> PathBuf {
    dir.join("assets")
}
fn asset_file(dir: &Path, id: &str, extension: &str) -> PathBuf {
    dir.join("assets").join(format!("{id}.{extension}"))
}

const MAX_IMPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CAMPAIGN_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CAMPAIGN_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SOURCE_PIXELS: u64 = 100_000_000;
const MAX_MAP_EDGE: u32 = 4096;
const MAX_TOKEN_EDGE: u32 = 1024;

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", uid()));
    fs::write(&temporary, contents).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let contents = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    atomic_write(path, &contents)
}

fn valid_asset_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn valid_extension(kind: &str, extension: &str) -> bool {
    let extension = extension.to_ascii_lowercase();
    match kind {
        "token" | "map" => matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp"),
        "audio" => matches!(extension.as_str(), "mp3" | "wav" | "ogg" | "m4a"),
        _ => false,
    }
}

fn copy_or_downscale_image(
    source: &Path,
    destination: &Path,
    kind: &str,
    extension: &str,
) -> Result<(), String> {
    let reader = ImageReader::open(source)
        .map_err(|error| error.to_string())?
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| error.to_string())?;
    if u64::from(width) * u64::from(height) > MAX_SOURCE_PIXELS {
        return Err("Image dimensions are too large".into());
    }
    let edge_limit = if kind == "map" {
        MAX_MAP_EDGE
    } else {
        MAX_TOKEN_EDGE
    };
    if width.max(height) <= edge_limit {
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    let format = ImageFormat::from_extension(extension)
        .ok_or_else(|| "Unsupported image format".to_string())?;
    let image = ImageReader::open(source)
        .map_err(|error| error.to_string())?
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .decode()
        .map_err(|error| error.to_string())?
        .resize(edge_limit, edge_limit, FilterType::Lanczos3);
    image
        .save_with_format(destination, format)
        .map_err(|error| error.to_string())
}

fn load_library(dir: &PathBuf) -> Library {
    fs::read_to_string(library_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Library {
            token_folders: vec![AssetFolder::default()],
            map_folders: vec![AssetFolder::default()],
            ..Default::default()
        })
}
fn save_library(dir: &PathBuf, lib: &Library) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let contents = serde_json::to_vec_pretty(lib).map_err(|e| e.to_string())?;
    atomic_write(&library_path(dir), &contents)
}

#[tauri::command]
pub fn get_library(state: State<Mutex<AppState>>) -> Result<Library, String> {
    let dir = state.lock().unwrap().data_dir.clone();
    Ok(load_library(&dir))
}

#[tauri::command]
pub fn create_campaign(
    state: State<Mutex<AppState>>,
    name: String,
    keep_scene: bool,
) -> Result<Library, String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let mut lib = load_library(&dir);
    let id = uid();
    // carry over whatever is on DEFAULT only if requested (first campaign ever)
    if keep_scene {
        if let Ok(s) = fs::read_to_string(default_scene_path(&dir)) {
            atomic_write(&scene_path(&dir, &id), s.as_bytes())?;
        }
    } else {
        write_json(&scene_path(&dir, &id), &Scene::default())?;
    }
    lib.campaigns.push(Campaign {
        id: id.clone(),
        name,
    });
    lib.current_campaign = Some(id);
    save_library(&dir, &lib)?;
    Ok(lib)
}

#[tauri::command]
pub fn save_folders(
    state: State<Mutex<AppState>>,
    token_folders: Vec<AssetFolder>,
    map_folders: Vec<AssetFolder>,
) -> Result<(), String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let mut lib = load_library(&dir);
    lib.token_folders = token_folders;
    lib.map_folders = map_folders;
    save_library(&dir, &lib)
}

#[tauri::command]
pub fn rename_campaign(
    state: State<Mutex<AppState>>,
    id: String,
    name: String,
) -> Result<Library, String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let mut lib = load_library(&dir);
    if let Some(c) = lib.campaigns.iter_mut().find(|c| c.id == id) {
        c.name = name;
    }
    save_library(&dir, &lib)?;
    Ok(lib)
}

#[tauri::command]
pub fn switch_campaign(state: State<Mutex<AppState>>, id: String) -> Result<Scene, String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let mut lib = load_library(&dir);
    if !lib.campaigns.iter().any(|campaign| campaign.id == id) {
        return Err("Campaign does not exist".into());
    }
    lib.current_campaign = Some(id.clone());
    save_library(&dir, &lib)?;
    let scene = fs::read_to_string(scene_path(&dir, &id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(scene)
}

#[tauri::command]
pub fn load_current_scene(state: State<Mutex<AppState>>) -> Result<Scene, String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let lib = load_library(&dir);
    let path = match &lib.current_campaign {
        Some(id) => scene_path(&dir, id),
        None => default_scene_path(&dir),
    };
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub fn save_scene(state: State<Mutex<AppState>>, scene: Scene) -> Result<(), String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let lib = load_library(&dir);
    let path = match &lib.current_campaign {
        Some(id) => scene_path(&dir, id),
        None => default_scene_path(&dir),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_json(&path, &scene)
}

#[derive(Serialize, Deserialize)]
struct CampaignPackage {
    version: u8,
    name: String,
    scene: Scene,
    #[serde(default)]
    assets: Vec<CampaignAsset>,
}

#[derive(Serialize, Deserialize)]
struct CampaignAsset {
    id: String,
    kind: String,
    name: String,
    folder_id: String,
    extension: String,
}

fn collect_campaign_assets(scene: &Scene, library: &Library, dir: &Path) -> Vec<CampaignAsset> {
    let mut assets = Vec::new();
    for id in scene
        .tokens
        .iter()
        .filter_map(|token| token.asset_id.as_ref())
    {
        if assets.iter().any(|asset: &CampaignAsset| asset.id == *id) {
            continue;
        }
        if let Some((folder_id, name)) = library.token_assets.get(id) {
            let extension = Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if valid_extension("token", &extension) && asset_file(dir, id, &extension).is_file() {
                assets.push(CampaignAsset {
                    id: id.clone(),
                    kind: "token".into(),
                    name: name.clone(),
                    folder_id: folder_id.clone(),
                    extension,
                });
            }
        }
    }
    for id in scene.map_objects.iter().map(|map| &map.asset_id) {
        if assets.iter().any(|asset: &CampaignAsset| asset.id == *id) {
            continue;
        }
        if let Some((folder_id, name)) = library.map_assets.get(id) {
            let extension = Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if valid_extension("map", &extension) && asset_file(dir, id, &extension).is_file() {
                assets.push(CampaignAsset {
                    id: id.clone(),
                    kind: "map".into(),
                    name: name.clone(),
                    folder_id: folder_id.clone(),
                    extension,
                });
            }
        }
    }
    assets
}

#[tauri::command]
pub fn export_campaign(state: State<Mutex<AppState>>, path: String) -> Result<(), String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let library = load_library(&dir);
    let (scene_file, name) = match &library.current_campaign {
        Some(id) => (
            scene_path(&dir, id),
            library
                .campaigns
                .iter()
                .find(|campaign| campaign.id == *id)
                .map(|campaign| campaign.name.clone())
                .unwrap_or_else(|| "Untitled campaign".into()),
        ),
        None => (default_scene_path(&dir), "Default campaign".into()),
    };
    let scene = fs::read_to_string(scene_file)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();
    let package = CampaignPackage {
        version: 2,
        name,
        assets: collect_campaign_assets(&scene, &library, &dir),
        scene,
    };
    let target = PathBuf::from(path);
    let temporary = target.with_extension(format!("tmp-{}", uid()));
    let result = (|| -> Result<(), String> {
        let file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        archive
            .start_file("campaign.json", options)
            .map_err(|error| error.to_string())?;
        archive
            .write_all(&serde_json::to_vec(&package).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        for asset in &package.assets {
            archive
                .start_file(format!("assets/{}.{}", asset.id, asset.extension), options)
                .map_err(|error| error.to_string())?;
            let mut source = fs::File::open(asset_file(&dir, &asset.id, &asset.extension))
                .map_err(|error| error.to_string())?;
            std::io::copy(&mut source, &mut archive).map_err(|error| error.to_string())?;
        }
        archive.finish().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, target).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_campaign(state: State<Mutex<AppState>>, path: String) -> Result<Library, String> {
    let source = PathBuf::from(path);
    let size = fs::metadata(&source).map_err(|e| e.to_string())?.len();
    if size > MAX_CAMPAIGN_PACKAGE_BYTES {
        return Err("Campaign file is too large".into());
    }
    let file = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut archive =
        ZipArchive::new(file).map_err(|_| "Invalid Vitreus campaign file".to_string())?;
    let mut manifest = archive
        .by_name("campaign.json")
        .map_err(|_| "Campaign manifest is missing".to_string())?;
    if manifest.size() > MAX_CAMPAIGN_BYTES {
        return Err("Campaign manifest is too large".into());
    }
    let mut manifest_bytes = Vec::with_capacity(manifest.size() as usize);
    manifest
        .read_to_end(&mut manifest_bytes)
        .map_err(|error| error.to_string())?;
    let mut package: CampaignPackage = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "Invalid Vitreus campaign manifest".to_string())?;
    drop(manifest);
    if package.version != 2 {
        return Err("Unsupported Vitreus campaign version".into());
    }
    let name = package.name.trim();
    if name.is_empty() || name.len() > 120 {
        return Err("Campaign name must contain 1–120 characters".into());
    }
    let dir = state.lock().unwrap().data_dir.clone();
    let mut library = load_library(&dir);
    let id = uid();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(assets_dir(&dir)).map_err(|e| e.to_string())?;
    let mut remapped_ids = std::collections::HashMap::new();
    let mut copied_paths = Vec::new();
    for asset in &package.assets {
        if !valid_asset_id(&asset.id)
            || !matches!(asset.kind.as_str(), "token" | "map")
            || !valid_extension(&asset.kind, &asset.extension)
        {
            continue;
        }
        let entry_name = format!("assets/{}.{}", asset.id, asset.extension);
        let mut entry = match archive.by_name(&entry_name) {
            Ok(entry) => entry,
            Err(_) => {
                for path in copied_paths {
                    let _ = fs::remove_file(path);
                }
                return Err(format!("Campaign asset is missing: {}", asset.name));
            }
        };
        if entry.size() > MAX_IMPORT_BYTES {
            for path in copied_paths {
                let _ = fs::remove_file(path);
            }
            return Err(format!("Campaign asset is too large: {}", asset.name));
        }
        let new_id = uid();
        let destination = asset_file(&dir, &new_id, &asset.extension);
        let mut output = match fs::File::create(&destination) {
            Ok(output) => output,
            Err(error) => {
                for path in copied_paths {
                    let _ = fs::remove_file(path);
                }
                return Err(error.to_string());
            }
        };
        if let Err(error) = std::io::copy(&mut entry, &mut output) {
            let _ = fs::remove_file(&destination);
            for path in copied_paths {
                let _ = fs::remove_file(path);
            }
            return Err(error.to_string());
        }
        copied_paths.push(destination);
        let folder = if asset.kind == "token"
            && library
                .token_folders
                .iter()
                .any(|folder| folder.id == asset.folder_id)
            || asset.kind == "map"
                && library
                    .map_folders
                    .iter()
                    .any(|folder| folder.id == asset.folder_id)
        {
            asset.folder_id.clone()
        } else {
            "root".into()
        };
        if asset.kind == "token" {
            library
                .token_assets
                .insert(new_id.clone(), (folder, asset.name.clone()));
        } else {
            library
                .map_assets
                .insert(new_id.clone(), (folder, asset.name.clone()));
        }
        remapped_ids.insert(asset.id.clone(), new_id);
    }
    for token in &mut package.scene.tokens {
        token.asset_id = token
            .asset_id
            .as_ref()
            .and_then(|asset_id| remapped_ids.get(asset_id).cloned());
    }
    package.scene.map_objects.retain_mut(|map| {
        if let Some(new_id) = remapped_ids.get(&map.asset_id) {
            map.asset_id = new_id.clone();
            true
        } else {
            false
        }
    });
    library.campaigns.push(Campaign {
        id: id.clone(),
        name: name.into(),
    });
    library.current_campaign = Some(id.clone());
    if let Err(error) = write_json(&scene_path(&dir, &id), &package.scene)
        .and_then(|_| save_library(&dir, &library))
    {
        for path in copied_paths {
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_file(scene_path(&dir, &id));
        return Err(error);
    }
    Ok(library)
}

#[derive(Serialize)]
pub struct ImportedAsset {
    pub id: String,
    pub ext: String,
    pub name: String,
}

/// Copies an arbitrary file the user picked (via the frontend's native file
/// dialog) into the app's managed asset directory, and records it in the
/// library under the given folder. Keeping this in Rust (rather than
/// reading/encoding the file in JS) is the "file asset parsing" half of the
/// original spec, and avoids ever holding a base64 copy of the image/audio
/// in memory on the JS side. `kind` is one of "token" | "map" | "audio".
#[tauri::command]
pub fn import_asset(
    state: State<Mutex<AppState>>,
    source_path: String,
    kind: String,
    folder_id: Option<String>,
) -> Result<ImportedAsset, String> {
    let dir = state.lock().unwrap().data_dir.clone();
    let adir = assets_dir(&dir);
    fs::create_dir_all(&adir).map_err(|e| e.to_string())?;
    if !matches!(kind.as_str(), "token" | "map" | "audio") {
        return Err("Unsupported asset type".into());
    }
    let src = PathBuf::from(&source_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&src).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_IMPORT_BYTES {
        return Err("Asset is not a supported local file or is too large".into());
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !valid_extension(&kind, &ext) {
        return Err("Unsupported file extension for this asset type".into());
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("asset")
        .to_string();
    let id = uid();
    let dest = adir.join(format!("{id}.{ext}"));
    if kind == "audio" {
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    } else {
        if let Err(error) = copy_or_downscale_image(&src, &dest, &kind, &ext) {
            let _ = fs::remove_file(&dest);
            return Err(error);
        }
    }

    let mut lib = load_library(&dir);
    match kind.as_str() {
        "token" => {
            let folder = folder_id
                .filter(|folder| lib.token_folders.iter().any(|item| item.id == *folder))
                .unwrap_or_else(|| "root".into());
            lib.token_assets.insert(id.clone(), (folder, name.clone()));
        }
        "map" => {
            let folder = folder_id
                .filter(|folder| lib.map_folders.iter().any(|item| item.id == *folder))
                .unwrap_or_else(|| "root".into());
            lib.map_assets.insert(id.clone(), (folder, name.clone()));
        }
        "audio" => {
            lib.tracks.push((id.clone(), name.clone()));
        }
        _ => {}
    }
    if let Err(error) = save_library(&dir, &lib) {
        let _ = fs::remove_file(&dest);
        return Err(error);
    }

    Ok(ImportedAsset { id, ext, name })
}

/// Resolves an asset id back to a path the frontend can load via Tauri's
/// asset protocol (`convertFileSrc`), without ever shipping the bytes
/// through an IPC message.
#[tauri::command]
pub fn asset_path(
    state: State<Mutex<AppState>>,
    id: String,
    ext: String,
) -> Result<String, String> {
    let dir = state.lock().unwrap().data_dir.clone();
    if !valid_asset_id(&id) || !valid_extension("token", &ext) && !valid_extension("audio", &ext) {
        return Err("Invalid asset path request".into());
    }
    let library = load_library(&dir);
    let recorded_name = library
        .token_assets
        .get(&id)
        .map(|(_, name)| name)
        .or_else(|| library.map_assets.get(&id).map(|(_, name)| name))
        .or_else(|| {
            library
                .tracks
                .iter()
                .find(|(asset_id, _)| asset_id == &id)
                .map(|(_, name)| name)
        });
    let Some(recorded_name) = recorded_name else {
        return Err("Asset does not exist in the library".into());
    };
    let recorded_ext = Path::new(recorded_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !recorded_ext.eq_ignore_ascii_case(&ext) {
        return Err("Asset extension does not match the library record".into());
    }
    let p = asset_file(&dir, &id, &ext.to_ascii_lowercase());
    if !p.is_file() {
        return Err("Asset file is missing".into());
    }
    Ok(p.to_string_lossy().to_string())
}

#[derive(Serialize, Deserialize)]
pub struct LightReq {
    pub ox: f64,
    pub oy: f64,
    pub max_dist: f64,
    pub facing: f64,
    pub cone: f64,
}

#[derive(Serialize, Deserialize)]
pub struct VisBatchInput {
    pub walls: Vec<Wall>,
    pub lights: Vec<LightReq>,
    #[serde(default = "default_visibility_samples")]
    pub sample_count: usize,
}

fn default_visibility_samples() -> usize {
    72
}

/// The heavy part: computes every active light's wall-occluded, cone-clipped
/// visibility polygon natively instead of in JS. This is the "line-of-sight
/// raycasting" piece of the original spec, moved out of the webview.
///
/// Batched rather than one call per light: wall-wall intersections are a
/// function of the wall set alone (not any particular light), so computing
/// them once per call here and reusing across every light in the batch
/// avoids redoing that O(walls^2) work N times for N lights sharing a scene
/// - and it's one IPC round-trip per frame-update instead of N.
#[tauri::command]
pub fn compute_visibility_batch(input: VisBatchInput) -> Vec<Vec<(f64, f64)>> {
    let walls: Vec<GeoWall> = input
        .walls
        .iter()
        .map(|w| GeoWall {
            a: GeoPoint { x: w.a.x, y: w.a.y },
            b: GeoPoint { x: w.b.x, y: w.b.y },
        })
        .collect();
    let wall_intersections = lighting::precompute_wall_intersections(&walls);
    input
        .lights
        .iter()
        .map(|lr| {
            let poly = lighting::visibility_polygon(
                lr.ox,
                lr.oy,
                lr.max_dist,
                &walls,
                &wall_intersections,
                input.sample_count,
            );
            let poly = if lr.cone < 359.5 {
                lighting::clip_to_cone(&poly, lr.ox, lr.oy, lr.facing, lr.cone)
            } else {
                poly
            };
            poly.into_iter().map(|p| (p.x, p.y)).collect()
        })
        .collect()
}

#[tauri::command]
pub fn clear_all_data(state: State<Mutex<AppState>>) -> Result<(), String> {
    let dir = state.lock().unwrap().data_dir.clone();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

fn uid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{n:x}")
}

pub fn init_state(app: &AppHandle) -> AppState {
    let data_dir = app
        .path()
        .app_data_dir()
        .expect("no app data dir")
        .join("vitreus");
    let _ = fs::create_dir_all(&data_dir);
    AppState { data_dir }
}
