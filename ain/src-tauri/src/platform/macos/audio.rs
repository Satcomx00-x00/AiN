//! Core Audio's property API: the system, each device and each process using audio is an object
//! whose properties are read and written by address (a four-letter selector, a scope, an element).

use std::{ffi::c_void, mem, ptr};

pub type ObjectId = u32;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

const fn code(c: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*c)
}

/// Scopes.
pub const GLOBAL: u32 = code(b"glob");
pub const OUTPUT: u32 = code(b"outp");
pub const INPUT: u32 = code(b"inpt");
/// The element that stands for the whole object, rather than one of its channels.
pub const MAIN: u32 = 0;

/// The audio system itself.
pub const SYSTEM: ObjectId = 1;

/// Selectors, as Core Audio's headers name them (`kAudio…Property…`).
pub const DEVICES: u32 = code(b"dev#");
pub const DEFAULT_OUTPUT: u32 = code(b"dOut");
pub const DEFAULT_INPUT: u32 = code(b"dIn ");
/// Every process using audio (macOS 14 and later).
pub const PROCESSES: u32 = code(b"prs#");
pub const NAME: u32 = code(b"lnam");
pub const DEVICE_UID: u32 = code(b"uid ");
pub const STREAMS: u32 = code(b"stm#");
pub const VOLUME: u32 = code(b"volm");
pub const MUTE: u32 = code(b"mute");
/// Whether any process uses the device.
pub const RUNNING_SOMEWHERE: u32 = code(b"gone");
pub const PROCESS_PID: u32 = code(b"ppid");
/// Whether the process records from any device.
pub const PROCESS_RUNNING_INPUT: u32 = code(b"piri");

impl Address {
    pub const fn new(selector: u32, scope: u32, element: u32) -> Self {
        Self { selector, scope, element }
    }

    pub const fn global(selector: u32) -> Self {
        Self::new(selector, GLOBAL, MAIN)
    }
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectHasProperty(object: ObjectId, address: *const Address) -> u8;
    fn AudioObjectIsPropertySettable(object: ObjectId, address: *const Address, settable: *mut u8) -> i32;
    fn AudioObjectGetPropertyDataSize(
        object: ObjectId,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> i32;
    fn AudioObjectGetPropertyData(
        object: ObjectId,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> i32;
    fn AudioObjectSetPropertyData(
        object: ObjectId,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> i32;
}

pub fn has(object: ObjectId, at: Address) -> bool {
    // SAFETY: `at` is a valid address for the duration of the call.
    unsafe { AudioObjectHasProperty(object, &at) != 0 }
}

pub fn settable(object: ObjectId, at: Address) -> bool {
    let mut settable = 0u8;
    // SAFETY: both pointers are valid for the call.
    has(object, at) && unsafe { AudioObjectIsPropertySettable(object, &at, &mut settable) } == 0 && settable != 0
}

/// A fixed-size property: a number, a flag, an object id.
pub fn get<T: Copy + Default>(object: ObjectId, at: Address) -> Option<T> {
    let mut value = T::default();
    let mut size = mem::size_of::<T>() as u32;
    // SAFETY: `value` has room for `size` bytes, and T is plain data.
    let status = unsafe { AudioObjectGetPropertyData(object, &at, 0, ptr::null(), &mut size, (&raw mut value).cast()) };
    (status == 0 && size as usize == mem::size_of::<T>()).then_some(value)
}

/// Writes a fixed-size property, if it can be written.
pub fn set<T: Copy>(object: ObjectId, at: Address, value: T) -> bool {
    // SAFETY: `value` is `size` bytes of plain data, alive for the call.
    settable(object, at)
        && unsafe { AudioObjectSetPropertyData(object, &at, 0, ptr::null(), mem::size_of::<T>() as u32, (&raw const value).cast()) } == 0
}

/// A list of objects, such as the system's devices or a device's streams.
pub fn objects(object: ObjectId, at: Address) -> Vec<ObjectId> {
    let mut size = 0u32;
    // SAFETY: `size` is valid for the call.
    if unsafe { AudioObjectGetPropertyDataSize(object, &at, 0, ptr::null(), &mut size) } != 0 {
        return Vec::new();
    }
    let mut ids = vec![0 as ObjectId; size as usize / mem::size_of::<ObjectId>()];
    // SAFETY: `ids` has room for `size` bytes.
    let status = unsafe { AudioObjectGetPropertyData(object, &at, 0, ptr::null(), &mut size, ids.as_mut_ptr().cast()) };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / mem::size_of::<ObjectId>());
    ids
}

/// A string property, such as a device's name.
pub fn string(object: ObjectId, at: Address) -> Option<String> {
    let cf: *const c_void = get::<usize>(object, at)? as *const c_void;
    // SAFETY: string properties hand over a CFString the caller releases.
    unsafe { super::take_string(cf) }
}
