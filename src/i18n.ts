// UI strings in English and Russian; Orca's UI language picks one (`orca.locale`). Info labels
// are looked up by key; EXIF and XMP tag names stay as their standard names in both languages.
// Only text the decoders write is translated: names and text from the file stay as they are.

import { ImageError } from './core/errors'
import { plural } from './core/plural'

/** A rewrite of an info value: a replacement string, or a function of the named groups. */
export type Rule = [RegExp, string | ((groups: Record<string, string>) => string)]

const en = {
  loading: 'Opening the image…',
  decoding: 'Decoding…',
  noHost: 'This page runs as an Orca custom editor.',
  textContent: 'Orca sent this file as text; Image Viewer needs its raw bytes.',
  errorTitle: 'This image cannot be shown',
  /** Shown under the no-decoder message for HEVC (HEIC pictures). */
  hevcHint:
    'HEIC pictures are compressed with HEVC, which Orca decodes only with the graphics hardware. A Mac always can; on Windows and Linux it depends on the graphics card and its driver (on Linux also on VA-API support). The file’s details are in the side pane.',
  errors: {
    empty: 'The file is empty.',
    'unknown-format': 'This file is not in a format Image Viewer reads, or its header is damaged.',
    truncated: 'The file ends too early: it is cut off or damaged.',
    damaged: 'The file is damaged ({detail}).',
    'unsupported-compression': 'Image Viewer cannot decode {detail} compression yet.',
    'unsupported-pixels': 'Image Viewer cannot decode the pixel format {detail} yet.',
    'unsupported-feature': '{detail} is not supported yet.',
    'too-large': 'The image is too large to decode in a tab ({detail} pixels).',
    'no-decoder': 'This Orca has no decoder for {detail}.',
    'no-video-decoder': 'This computer has no {detail} decoder that Orca can use, so the picture cannot be shown.',
    'decode-failed': 'The image data could not be decoded ({detail}).',
    'text-file': 'This is a text file, not an image. Switch to Source in the view toggle to read it.'
  },
  notices: {
    'raw-preview': 'Camera RAW: this is the largest preview the camera embedded ({detail}), not a development of the sensor data.',
    'psd-no-composite': 'The file was saved without “Maximize compatibility”, so it has no flattened image. Shown: a simple composite of the visible layers.',
    'psd-composite-simple': 'Composite of the visible layers made here: blend modes, opacity, masks and clipping, without layer effects or adjustment layers.',
    'damaged-partial': 'The file is damaged or cut off. The part that could be read is shown.',
    'heic-alpha-skipped': 'The transparency of this image could not be decoded; it is shown opaque.',
    'cmyk-converted': 'CMYK shown as RGB with a simple conversion, without the colour profile.',
    'lab-converted': 'CIELAB converted to sRGB.',
    'ycc-converted': 'YCbCr converted to RGB.',
    'exr-multipart': 'A multi-part file: pick a part in the toolbar.',
    'unsupported-images': 'Some images in this file cannot be decoded: {detail}.'
  },
  axes: {
    page: 'Page',
    mip: 'Mip',
    face: 'Face',
    layer: 'Layer',
    slice: 'Slice',
    size: 'Size',
    part: 'Part',
    image: 'Image',
    frame: 'Frame'
  },
  channel: 'Channel',
  channels: { rgb: 'Colour', gray: 'Grey', r: 'Red', g: 'Green', b: 'Blue', a: 'Alpha', luma: 'Luminance' },
  exposure: 'Exposure',
  exposureHint: 'Exposure in stops (E, Shift+E)',
  toneMap: 'Tone map',
  toneMaps: { clip: 'Clip', reinhard: 'Reinhard', aces: 'Filmic' },
  toneMapHint: 'How bright values above white are shown',
  levels: 'Levels',
  auto: 'Auto',
  autoExposureHint: 'Set the exposure from the brightest highlights',
  autoContrastHint: 'Stretch the values between the darkest and brightest pixels',
  reset: 'Reset',
  resetHint: 'Back to the file’s own values',
  zoomIn: 'Zoom in (+)',
  zoomOut: 'Zoom out (−)',
  fit: 'Fit',
  fitHint: 'Fit to the window (0)',
  actual: '1:1',
  actualHint: 'Actual size, one image pixel per screen pixel (1)',
  save: 'Save as PNG…',
  saveHint: 'Save what you see — this image with the current channel and exposure — as a PNG',
  saving: 'Encoding PNG…',
  saved: 'Saved',
  saveFailed: 'Could not save the PNG',
  saveTooBig: 'The PNG would be larger than 64 MB, the most Orca saves from a plugin.',
  copy: 'Copy',
  copyHint: 'Copy this image to the clipboard as PNG',
  copied: 'Copied',
  copyFailed: 'The clipboard is not available here. Use Save as PNG… instead.',
  details: 'Details',
  detailsHint: 'Show or hide the details pane (I)',
  tabs: { info: 'Info', layers: 'Layers', list: 'Images' },
  composite: 'Composite',
  compositeHint: 'The flattened image',
  compositeSaved: 'Saved composite',
  compositeLayers: 'Visible layers',
  layerAlone: 'Only this layer',
  showLayer: 'Show or hide this layer in the composite',
  noPixels: 'No pixels',
  bitsInt: '{n}-bit',
  bitsFloat: '{n}-bit float',
  channelCount: '{n} ch',
  hidden: 'hidden',
  group: 'Group',
  pixel: 'Pixel',
  unsupportedImage: 'This image cannot be shown: {detail}.',
  histogram: 'Histogram',
  copyValue: 'Copy',
  copiedValue: 'Copied',
  sections: {
    image: 'Image',
    file: 'File',
    camera: 'Camera',
    gps: 'Location',
    exif: 'EXIF',
    xmp: 'XMP',
    icc: 'Colour profile',
    makernote: 'Maker note',
    layer: 'Layer',
    selected: 'This image',
    format: 'Format details',
    channelsList: 'Channels',
    attributes: 'Header attributes',
    items: 'Items'
  },
  labels: {
    dimensions: 'Dimensions',
    bitDepth: 'Bit depth',
    channels: 'Channels',
    compression: 'Compression',
    colorSpace: 'Colour space',
    colorMode: 'Colour mode',
    type: 'Type',
    origin: 'Origin',
    paletteSize: 'Palette',
    imageId: 'Image ID',
    author: 'Author',
    comment: 'Comment',
    created: 'Created',
    modified: 'Modified',
    software: 'Software',
    job: 'Job',
    alphaType: 'Alpha',
    version: 'Version',
    pixelFormat: 'Pixel format',
    scanOrder: 'Scan order',
    exposureHeader: 'Exposure (header)',
    gamma: 'Gamma',
    primaries: 'Primaries',
    view: 'View',
    iccProfile: 'ICC profile',
    iccDetails: 'Profile',
    copyright: 'Copyright',
    camera: 'Camera',
    lens: 'Lens',
    exposure: 'Exposure',
    focalLength: 'Focal length',
    flash: 'Flash',
    taken: 'Taken',
    serial: 'Serial number',
    artist: 'Artist',
    description: 'Description',
    position: 'Position',
    latitude: 'Latitude',
    longitude: 'Longitude',
    altitude: 'Altitude',
    direction: 'Direction',
    speed: 'Speed',
    gpsTime: 'GPS time',
    photometric: 'Photometric',
    planar: 'Planar configuration',
    predictor: 'Predictor',
    layout: 'Layout',
    resolution: 'Resolution',
    orientation: 'Orientation',
    sampleFormat: 'Sample format',
    extraSamples: 'Extra samples',
    pages: 'Pages',
    subfile: 'Subfile',
    pageName: 'Page name',
    byteOrder: 'Byte order',
    variant: 'Variant',
    layers: 'Layers',
    blend: 'Blend mode',
    opacity: 'Opacity',
    visible: 'Visibility',
    bounds: 'Bounds',
    composite: 'Flattened image',
    guides: 'Guides',
    slices: 'Slices',
    dataWindow: 'Data window',
    displayWindow: 'Display window',
    lineOrder: 'Line order',
    pixelAspect: 'Pixel aspect ratio',
    tiles: 'Tiles',
    parts: 'Parts',
    partName: 'Part name',
    partType: 'Part type',
    format: 'Format',
    mipmaps: 'Mip levels',
    faces: 'Faces',
    arraySize: 'Array size',
    sizes: 'Sizes',
    darkVariant: 'Dark variant',
    toc: 'Table of contents entries',
    alphaMode: 'Alpha mode',
    header: 'Header',
    rowAlignment: 'Row alignment, bytes',
    depth: 'Depth',
    entries: 'Entries',
    entry: 'Entry',
    brands: 'Brands',
    codec: 'Codec',
    grid: 'Grid',
    rotation: 'Rotation',
    mirror: 'Mirror',
    alpha: 'Alpha',
    thumbnails: 'Thumbnails',
    auxiliary: 'Auxiliary images',
    items: 'Items',
    preview: 'Preview',
    previews: 'Embedded previews',
    rawFormat: 'RAW format',
    model: 'Model',
    noData: 'No-data value',
    sensor: 'Sensor size',
    fileSize: 'File size',
    frames: 'Frames',
    count: 'Count',
    size: 'Size',
    name: 'Name',
    kind: 'Kind',
    premultiplied: 'Premultiplied',
    range: 'Value range',
    encoding: 'Encoding',
    hardware: 'Decoder',
    profile: 'Profile',
    printSize: 'Print size'
  },
  /** Whole values the readers write, by their English text; English values are shown as made. */
  values: {} as Record<string, string>,
  imageLabels: {
    page: 'Page {n}',
    pageReduced: 'Page {n} (reduced)',
    subImage: 'sub-image {n}',
    layer: 'Layer {n}',
    mip: 'Mip {n}',
    slice: 'Slice {n}',
    level: 'level {n}',
    dark: 'Dark',
    largestPreview: 'Largest preview',
    preview: 'Preview',
    thumbnail: 'Thumbnail',
    thumbnailSize: 'Thumbnail {size}',
    thumbnailOf: 'Thumbnail of {n} {size}',
    primary: 'Primary image',
    image: 'Image',
    imageN: 'Image {n}',
    composite: 'Composite',
    deep: 'Deep image',
    empty: 'Empty',
    alpha: 'Alpha',
    depth: 'Depth',
    portraitMatte: 'Portrait matte',
    gainMap: 'HDR gain map',
    skinMatte: 'Skin matte',
    hairMatte: 'Hair matte',
    teethMatte: 'Teeth matte',
    glassesMatte: 'Glasses matte',
    skyMatte: 'Sky matte',
    deepData: 'deep data',
    noChannels: 'no channels',
    compression: '{name} compression'
  },
  /** Rewrites of info values by key (units, flash modes); English values are shown as made. */
  valueRules: {
    // Any key: byte counts in the UI language's number format.
    '*': [[/(?<n>\d+) bytes$/, (g) => `${Number(g.n).toLocaleString('en')} ${plural('en', Number(g.n), { one: 'byte', other: 'bytes' })}`]]
  } as Record<string, Rule[]>,
  /** Error details: whole phrases, then patterns, then the parts of "<format> <part>". */
  errorDetails: {} as Record<string, string>,
  errorRules: [] as [RegExp, string][],
  structureParts: {} as Record<string, string>,
  units: { b: 'B', kb: 'KB', mb: 'MB', gb: 'GB' }
}

export type Strings = typeof en

const RU_FLASH: Rule[] = [
  [/Did not fire/, 'Не сработала'],
  [/Fired/, 'Сработала'],
  [/compulsory/, 'принудительно'],
  [/\boff\b/, 'выключена'],
  [/\bauto\b/, 'авто'],
  [/red-eye reduction/, 'подавление красных глаз'],
  [/no flash function/, 'вспышки нет']
]

/** "3 плитки", "5 плиток", "1 234 байта": a count in Russian number format with its plural form. */
function ruCount(n: string, one: string, few: string, many: string): string {
  const v = Number(n)
  return `${v.toLocaleString('ru')} ${plural('ru', v, { one, few, many, other: few })}`
}

const ru: Strings = {
  loading: 'Открываю изображение…',
  decoding: 'Декодирую…',
  noHost: 'Эта страница работает как редактор Orca.',
  textContent: 'Orca передала файл как текст, а просмотрщику нужны исходные байты.',
  errorTitle: 'Изображение не открывается',
  hevcHint:
    'Картинки HEIC сжаты в HEVC, а его Orca декодирует только средствами видеокарты. На Mac это работает всегда; в Windows и Linux зависит от видеокарты и её драйвера (в Linux ещё и от поддержки VA-API). Сведения о файле — в боковой панели.',
  errors: {
    empty: 'Файл пуст.',
    'unknown-format': 'Формат этого файла Image Viewer не читает, или заголовок повреждён.',
    truncated: 'Файл обрывается раньше времени: он обрезан или повреждён.',
    damaged: 'Файл повреждён ({detail}).',
    'unsupported-compression': 'Сжатие {detail} Image Viewer пока не декодирует.',
    'unsupported-pixels': 'Формат пикселей {detail} Image Viewer пока не декодирует.',
    'unsupported-feature': '{detail} пока не поддерживается.',
    'too-large': 'Изображение слишком большое для вкладки ({detail} пикселей).',
    'no-decoder': 'В этой Orca нет декодера для {detail}.',
    'no-video-decoder': 'На этом компьютере нет декодера {detail}, доступного Orca, поэтому картинку не показать.',
    'decode-failed': 'Не удалось декодировать данные изображения ({detail}).',
    'text-file': 'Это текстовый файл, а не изображение. Чтобы его прочитать, переключитесь на Source.'
  },
  notices: {
    'raw-preview': 'Camera RAW: показано самое большое превью, встроенное камерой ({detail}), а не проявка данных сенсора.',
    'psd-no-composite': 'Файл сохранён без «Максимальной совместимости», сведённого изображения в нём нет. Показано простое наложение видимых слоёв.',
    'psd-composite-simple': 'Видимые слои сведены здесь: режимы наложения, непрозрачность, маски и обтравочные маски, без стилей слоя и корректирующих слоёв.',
    'damaged-partial': 'Файл повреждён или обрезан. Показана часть, которую удалось прочитать.',
    'heic-alpha-skipped': 'Прозрачность этого изображения не декодировалась, оно показано непрозрачным.',
    'cmyk-converted': 'CMYK показан как RGB простым пересчётом, без цветового профиля.',
    'lab-converted': 'CIELAB пересчитан в sRGB.',
    'ycc-converted': 'YCbCr пересчитан в RGB.',
    'exr-multipart': 'Файл из нескольких частей: выберите часть на панели.',
    'unsupported-images': 'Некоторые изображения в файле не декодируются: {detail}.'
  },
  axes: {
    page: 'Страница',
    mip: 'MIP',
    face: 'Грань',
    layer: 'Слой',
    slice: 'Срез',
    size: 'Размер',
    part: 'Часть',
    image: 'Изображение',
    frame: 'Кадр'
  },
  channel: 'Канал',
  channels: { rgb: 'Цвет', gray: 'Серый', r: 'Красный', g: 'Зелёный', b: 'Синий', a: 'Альфа', luma: 'Яркость' },
  exposure: 'Экспозиция',
  exposureHint: 'Экспозиция в ступенях (E, Shift+E)',
  toneMap: 'Тональная кривая',
  toneMaps: { clip: 'Обрезка', reinhard: 'Рейнхард', aces: 'Плёночная' },
  toneMapHint: 'Как показывать значения ярче белого',
  levels: 'Уровни',
  auto: 'Авто',
  autoExposureHint: 'Подобрать экспозицию по самым ярким участкам',
  autoContrastHint: 'Растянуть значения между самым тёмным и самым светлым пикселем',
  reset: 'Сброс',
  resetHint: 'Вернуть значения из файла',
  zoomIn: 'Увеличить (+)',
  zoomOut: 'Уменьшить (−)',
  fit: 'Вписать',
  fitHint: 'Вписать в окно (0)',
  actual: '1:1',
  actualHint: 'Реальный размер: пиксель изображения на пиксель экрана (1)',
  save: 'Сохранить как PNG…',
  saveHint: 'Сохранить то, что видно, — это изображение с текущим каналом и экспозицией — в PNG',
  saving: 'Кодирую PNG…',
  saved: 'Сохранено',
  saveFailed: 'Не удалось сохранить PNG',
  saveTooBig: 'PNG получится больше 64 МБ — это предел, который Orca сохраняет из плагина.',
  copy: 'Копировать',
  copyHint: 'Скопировать изображение в буфер обмена как PNG',
  copied: 'Скопировано',
  copyFailed: 'Буфер обмена здесь недоступен. Воспользуйтесь «Сохранить как PNG…».',
  details: 'Сведения',
  detailsHint: 'Показать или скрыть панель сведений (I)',
  tabs: { info: 'Сведения', layers: 'Слои', list: 'Изображения' },
  composite: 'Итог',
  compositeHint: 'Сведённое изображение',
  compositeSaved: 'Сведённое из файла',
  compositeLayers: 'Видимые слои',
  layerAlone: 'Только этот слой',
  showLayer: 'Показать или скрыть слой в наложении',
  noPixels: 'Нет пикселей',
  bitsInt: '{n} бит',
  bitsFloat: '{n} бит (плав.)',
  channelCount: '{n} кан.',
  hidden: 'скрыт',
  group: 'Группа',
  pixel: 'Пиксель',
  unsupportedImage: 'Это изображение не показывается: {detail}.',
  histogram: 'Гистограмма',
  copyValue: 'Копировать',
  copiedValue: 'Скопировано',
  sections: {
    image: 'Изображение',
    file: 'Файл',
    camera: 'Камера',
    gps: 'Местоположение',
    exif: 'EXIF',
    xmp: 'XMP',
    icc: 'Цветовой профиль',
    makernote: 'Данные производителя',
    layer: 'Слой',
    selected: 'Это изображение',
    format: 'Подробности формата',
    channelsList: 'Каналы',
    attributes: 'Атрибуты заголовка',
    items: 'Элементы'
  },
  labels: {
    dimensions: 'Размеры',
    bitDepth: 'Разрядность',
    channels: 'Каналы',
    compression: 'Сжатие',
    colorSpace: 'Цветовое пространство',
    colorMode: 'Цветовой режим',
    type: 'Тип',
    origin: 'Начало координат',
    paletteSize: 'Палитра',
    imageId: 'ID изображения',
    author: 'Автор',
    comment: 'Комментарий',
    created: 'Создан',
    modified: 'Изменён',
    software: 'Программа',
    job: 'Задание',
    alphaType: 'Альфа',
    version: 'Версия',
    pixelFormat: 'Формат пикселей',
    scanOrder: 'Порядок строк',
    exposureHeader: 'Экспозиция (заголовок)',
    gamma: 'Гамма',
    primaries: 'Основные цвета',
    view: 'Камера (VIEW)',
    iccProfile: 'ICC-профиль',
    iccDetails: 'Профиль',
    copyright: 'Авторские права',
    camera: 'Камера',
    lens: 'Объектив',
    exposure: 'Экспозиция',
    focalLength: 'Фокусное расстояние',
    flash: 'Вспышка',
    taken: 'Снято',
    serial: 'Серийный номер',
    artist: 'Автор',
    description: 'Описание',
    position: 'Координаты',
    latitude: 'Широта',
    longitude: 'Долгота',
    altitude: 'Высота',
    direction: 'Направление',
    speed: 'Скорость',
    gpsTime: 'Время GPS',
    photometric: 'Фотометрия',
    planar: 'Расположение каналов',
    predictor: 'Предиктор',
    layout: 'Разбиение',
    resolution: 'Разрешение',
    orientation: 'Ориентация',
    sampleFormat: 'Формат отсчётов',
    extraSamples: 'Доп. каналы',
    pages: 'Страницы',
    subfile: 'Подфайл',
    pageName: 'Имя страницы',
    byteOrder: 'Порядок байтов',
    variant: 'Вариант',
    layers: 'Слои',
    blend: 'Режим наложения',
    opacity: 'Непрозрачность',
    visible: 'Видимость',
    bounds: 'Границы',
    composite: 'Сведённое изображение',
    guides: 'Направляющие',
    slices: 'Фрагменты',
    dataWindow: 'Окно данных',
    displayWindow: 'Окно показа',
    lineOrder: 'Порядок строк',
    pixelAspect: 'Пропорции пикселя',
    tiles: 'Тайлы',
    parts: 'Части',
    partName: 'Имя части',
    partType: 'Тип части',
    format: 'Формат',
    mipmaps: 'MIP-уровни',
    faces: 'Грани',
    arraySize: 'Размер массива',
    sizes: 'Размеры',
    darkVariant: 'Тёмный вариант',
    toc: 'Записей в оглавлении',
    alphaMode: 'Режим альфы',
    header: 'Заголовок',
    rowAlignment: 'Выравнивание строк, байт',
    depth: 'Глубина',
    entries: 'Записи',
    entry: 'Запись',
    brands: 'Бренды',
    codec: 'Кодек',
    grid: 'Сетка',
    rotation: 'Поворот',
    mirror: 'Отражение',
    alpha: 'Альфа',
    thumbnails: 'Миниатюры',
    auxiliary: 'Вспомогательные изображения',
    items: 'Элементы',
    preview: 'Превью',
    previews: 'Встроенные превью',
    rawFormat: 'Формат RAW',
    model: 'Модель',
    noData: 'Значение «нет данных»',
    sensor: 'Размер сенсора',
    fileSize: 'Размер файла',
    frames: 'Кадры',
    count: 'Количество',
    size: 'Размер',
    name: 'Имя',
    kind: 'Вид',
    premultiplied: 'Предумноженная',
    range: 'Диапазон значений',
    encoding: 'Кодирование',
    hardware: 'Декодер',
    profile: 'Профиль',
    printSize: 'Размер при печати'
  },
  values: {
    None: 'Нет',
    Yes: 'Да',
    No: 'Нет',
    Grey: 'Серый',
    'Grey + alpha': 'Серый + альфа',
    Linear: 'Линейное',
    Normal: 'Обычный',
    Hidden: 'Скрыт',
    Visible: 'Виден',
    Unsupported: 'Не поддерживается',
    Straight: 'Обычная',
    Premultiplied: 'Предумноженная',
    Opaque: 'Непрозрачная',
    Custom: 'Особая',
    Legacy: 'Старый',
    'Lossless JPEG': 'JPEG без потерь',
    'Not saved (composited from layers)': 'Не сохранено (собрано из слоёв)',
    'Missing, the file is cut off (composited from layers)': 'Нет, файл обрезан (собрано из слоёв)',
    Packed: 'Упакованные данные',
    'Pass through': 'Пропустить',
    Dissolve: 'Затухание',
    Darken: 'Затемнение',
    Multiply: 'Умножение',
    'Colour burn': 'Затемнение основы',
    'Linear burn': 'Линейный затемнитель',
    'Darker colour': 'Темнее',
    Lighten: 'Замена светлым',
    Screen: 'Экран',
    'Colour dodge': 'Осветление основы',
    'Linear dodge (add)': 'Линейный осветлитель (добавить)',
    'Lighter colour': 'Светлее',
    Overlay: 'Перекрытие',
    'Soft light': 'Мягкий свет',
    'Hard light': 'Жёсткий свет',
    'Vivid light': 'Яркий свет',
    'Linear light': 'Линейный свет',
    'Pin light': 'Точечный свет',
    'Hard mix': 'Жёсткое смешение',
    Difference: 'Разница',
    Exclusion: 'Исключение',
    Subtract: 'Вычитание',
    Divide: 'Разделить',
    Hue: 'Цветовой тон',
    Saturation: 'Насыщенность',
    Colour: 'Цветность',
    Luminosity: 'Яркость',
    Pixels: 'Пиксели',
    Group: 'Группа',
    Text: 'Текст',
    Adjustment: 'Коррекция',
    'Smart object': 'Смарт-объект',
    Fill: 'Заливка',
    Empty: 'Пустой',
    // TIFF
    'Grey (white is zero)': 'Серый (белый — ноль)',
    Palette: 'Палитра',
    'Transparency mask': 'Маска прозрачности',
    'Separated (CMYK)': 'Цветоделение (CMYK)',
    'Colour filter array': 'Мозаика цветных фильтров',
    'Linear raw': 'Линейные данные сенсора',
    'Horizontal differencing': 'Горизонтальные разности',
    'Floating point': 'С плавающей точкой',
    'Separate planes': 'Отдельные плоскости',
    'Chunky (interleaved)': 'Вперемешку в каждом пикселе',
    'Little-endian (II)': 'От младшего байта (II)',
    'Big-endian (MM)': 'От старшего байта (MM)',
    'Classic TIFF': 'Обычный TIFF',
    'CCITT modified Huffman RLE': 'CCITT, модифицированный код Хаффмана',
    'CCITT Group 3 fax': 'CCITT, факс группы 3',
    'CCITT Group 4 fax': 'CCITT, факс группы 4',
    'JPEG (old-style)': 'JPEG (старый вариант)',
    'JPEG (lossy DNG)': 'JPEG (DNG с потерями)',
    'IT8 CT padding': 'IT8, заполнение CT',
    'IT8 line work RLE': 'IT8, штриховая графика RLE',
    'IT8 monochrome': 'IT8, монохромное',
    'IT8 binary line art': 'IT8, двухцветная штриховая графика',
    'Pixar film': 'Pixar, плёночное',
    'Pixar log': 'Pixar, логарифмическое',
    'Mirrored horizontally': 'Отражено по горизонтали',
    'Mirrored vertically': 'Отражено по вертикали',
    'Rotated 180°': 'Повёрнуто на 180°',
    'Rotated 90° CW': 'Повёрнуто на 90° по часовой стрелке',
    'Rotated 90° CCW': 'Повёрнуто на 90° против часовой стрелки',
    'Mirrored, rotated 90° CW': 'Отражено и повёрнуто на 90° по часовой стрелке',
    'Mirrored, rotated 90° CCW': 'Отражено и повёрнуто на 90° против часовой стрелки',
    // PSD
    Bitmap: 'Битовый',
    Greyscale: 'Градации серого',
    Indexed: 'Индексированные цвета',
    Multichannel: 'Многоканальный',
    Duotone: 'Дуплекс',
    Raw: 'Без сжатия',
    'ZIP with prediction': 'ZIP с предсказанием',
    'PSB (large document)': 'PSB (большой документ)',
    // TGA
    'Colour-mapped': 'С палитрой',
    'True colour': 'Полноцветный',
    'Colour-mapped, RLE': 'С палитрой, RLE',
    'True colour, RLE': 'Полноцветный, RLE',
    'Greyscale, RLE': 'Градации серого, RLE',
    'Top-left': 'Сверху слева',
    'Top-right': 'Сверху справа',
    'Bottom-left': 'Снизу слева',
    'Bottom-right': 'Снизу справа',
    'Undefined (ignored)': 'Не задана (не учитывается)',
    'Undefined (kept)': 'Не задана (сохраняется)',
    Alpha: 'Альфа',
    'Premultiplied alpha': 'Предумноженная альфа',
    // Radiance HDR, HEIF, DDS, OpenEXR
    'RGBE (shared exponent)': 'RGBE (общий порядок)',
    'XYZE (shown as linear sRGB)': 'XYZE (показан как линейный sRGB)',
    'YCbCr + alpha': 'YCbCr + альфа',
    Depth: 'Глубина',
    'Portrait matte': 'Маска портрета',
    'Skin matte': 'Маска кожи',
    'Hair matte': 'Маска волос',
    'Teeth matte': 'Маска зубов',
    'Glasses matte': 'Маска очков',
    'Sky matte': 'Маска неба',
    Auxiliary: 'Вспомогательное',
    'Increasing Y': 'По возрастанию Y',
    'Decreasing Y': 'По убыванию Y',
    'Random Y': 'В любом порядке',
    'Latitude-longitude': 'Широта и долгота',
    Cube: 'Куб',
    // EXIF named values
    inches: 'дюймы',
    cm: 'см',
    mm: 'мм',
    µm: 'мкм',
    Centered: 'По центру',
    'Co-sited': 'Совмещённое',
    'Not defined': 'Не задано',
    Manual: 'Вручную',
    'Program AE': 'Программная автоэкспозиция',
    'Aperture priority': 'Приоритет диафрагмы',
    'Shutter priority': 'Приоритет выдержки',
    Creative: 'Творческая',
    Action: 'Движение',
    Portrait: 'Портрет',
    Landscape: 'Пейзаж',
    Bulb: 'Ручная выдержка (Bulb)',
    Unknown: 'Неизвестно',
    Average: 'Среднее',
    'Center-weighted average': 'Центровзвешенный',
    Spot: 'Точечный',
    'Multi-spot': 'Многоточечный',
    'Multi-segment': 'Матричный',
    Partial: 'Частичный',
    Other: 'Другое',
    Daylight: 'Дневной свет',
    Fluorescent: 'Лампа дневного света',
    Tungsten: 'Лампа накаливания',
    Flash: 'Вспышка',
    'Fine weather': 'Ясная погода',
    Cloudy: 'Облачно',
    Shade: 'Тень',
    'Daylight fluorescent': 'Люминесцентная, дневной свет',
    'Day white fluorescent': 'Люминесцентная, дневной белый',
    'Cool white fluorescent': 'Люминесцентная, холодный белый',
    'White fluorescent': 'Люминесцентная, белый',
    'Standard light A': 'Стандартный источник A',
    'Standard light B': 'Стандартный источник B',
    'Standard light C': 'Стандартный источник C',
    'ISO studio tungsten': 'Студийная лампа накаливания ISO',
    Uncalibrated: 'Не откалибровано',
    'ICC Profile': 'Профиль ICC',
    'One-chip color area': 'Однокристальный цветной сенсор',
    'Two-chip color area': 'Двухкристальный цветной сенсор',
    'Three-chip color area': 'Трёхкристальный цветной сенсор',
    'Color sequential area': 'Последовательный цветной сенсор',
    Trilinear: 'Трилинейный',
    'Color sequential linear': 'Последовательный линейный',
    'HDR (no original saved)': 'HDR (без исходного снимка)',
    'HDR (original saved)': 'HDR (исходный снимок сохранён)',
    'Original (for HDR)': 'Исходный снимок (для HDR)',
    Panorama: 'Панорама',
    'Portrait HDR': 'Портрет HDR',
    Auto: 'Авто',
    'Auto bracket': 'Автобрекетинг',
    Standard: 'Стандартная',
    Night: 'Ночная',
    'Low gain up': 'Слабое усиление',
    'High gain up': 'Сильное усиление',
    'Low gain down': 'Слабое ослабление',
    'High gain down': 'Сильное ослабление',
    Low: 'Низкий',
    High: 'Высокий',
    Soft: 'Мягкая',
    Hard: 'Жёсткая',
    Macro: 'Макро',
    Close: 'Близко',
    Distant: 'Далеко',
    'Standard output sensitivity': 'Стандартная выходная чувствительность (SOS)',
    'Recommended exposure index': 'Рекомендуемый индекс экспозиции (REI)',
    'ISO speed': 'Светочувствительность ISO',
    'SOS and REI': 'SOS и REI',
    'SOS and ISO speed': 'SOS и ISO',
    'REI and ISO speed': 'REI и ISO',
    'SOS, REI and ISO speed': 'SOS, REI и ISO',
    'Film scanner': 'Плёночный сканер',
    'Reflection print scanner': 'Сканер отпечатков',
    'Digital camera': 'Цифровая камера',
    'Directly photographed': 'Снято напрямую',
    'Not a composite': 'Не составное',
    'General composite': 'Составное',
    'Composite captured when shooting': 'Составное, собрано при съёмке',
    'Above sea level': 'Выше уровня моря',
    'Below sea level': 'Ниже уровня моря',
    'No correction': 'Без коррекции',
    'Differential corrected': 'Дифференциальная коррекция'
  },
  imageLabels: {
    page: 'Страница {n}',
    pageReduced: 'Страница {n} (уменьшенная)',
    subImage: 'вложенное изображение {n}',
    layer: 'Слой {n}',
    mip: 'MIP-уровень {n}',
    slice: 'Срез {n}',
    level: 'уровень {n}',
    dark: 'Тёмный вариант',
    largestPreview: 'Наибольшее превью',
    preview: 'Превью',
    thumbnail: 'Миниатюра',
    thumbnailSize: 'Миниатюра {size}',
    thumbnailOf: 'Миниатюра изображения {n} {size}',
    primary: 'Основное изображение',
    image: 'Изображение',
    imageN: 'Изображение {n}',
    composite: 'Итог',
    deep: 'Глубинное изображение',
    empty: 'Пусто',
    alpha: 'Альфа',
    depth: 'Глубина',
    portraitMatte: 'Маска портрета',
    gainMap: 'Карта усиления HDR',
    skinMatte: 'Маска кожи',
    hairMatte: 'Маска волос',
    teethMatte: 'Маска зубов',
    glassesMatte: 'Маска очков',
    skyMatte: 'Маска неба',
    deepData: 'глубинные данные',
    noChannels: 'нет каналов',
    compression: 'сжатие {name}'
  },
  errorDetails: {
    'a RAW file without an embedded preview': 'RAW-файл без встроенного превью',
    'this RAW variant': 'Этот вариант RAW',
    composite: 'Сведённое изображение',
    'HEIF item-offset construction': 'Сборка элементов HEIF по смещению',
    'planar JPEG': 'Планарный JPEG',
    'floating-point predictor on integers': 'Предиктор для чисел с плавающей точкой на целых отсчётах',
    'complex samples': 'комплексные отсчёты',
    'floating-point CMYK': 'CMYK с плавающей точкой',
    'subsampled YCbCr other than 8-bit chunky': 'прореженный YCbCr, кроме 8-битного чередующегося',
    'colour filter array (sensor data)': 'мозаика цветных фильтров (данные сенсора)',
    'deep data': 'глубокие данные',
    'no channels': 'нет каналов',
    preview: 'превью',
    canvas: 'холста',
    'Lab without three channels': 'Lab без трёх каналов',
    'RGB with fewer than 3 samples': 'RGB меньше чем с тремя отсчётами',
    'YCbCr subsampling': 'прореживание YCbCr',
    'IFD entry count': 'число записей IFD',
    'IFD offset': 'смещение IFD',
    'JPEG data': 'данные JPEG',
    DEFLATE: 'DEFLATE'
  },
  errorRules: [
    [/^horizontal predictor with (?<n>\d+)-bit samples$/, 'Горизонтальный предиктор для $<n>-битных отсчётов'],
    [/^OpenEXR version (?<n>\d+)$/, 'OpenEXR версии $<n>'],
    [/^(?<n>\d+)-bit (?<what>CMYK|L\*a\*b\*|YCbCr|PSD|JPEG)$/, '$<n>-битный $<what>'],
    [/^(?<n>\d+)-bit palette$/, '$<n>-битная палитра'],
    [/^(?<n>\d+)-bit colour-mapped$/, '$<n>-битный с палитрой'],
    [/^(?<n>\d+)-bit greyscale$/, '$<n>-битный серый'],
    [/^(?<n>\d+)-bit floating point$/, '$<n>-битные числа с плавающей точкой'],
    [/^(?<n>\d+)-bit integers$/, '$<n>-битные целые'],
    [/^(?<n>\d+)-ink separation$/, 'цветоделение на $<n> красок'],
    [/^mixed bit depths \((?<v>.+)\)$/, 'разная разрядность каналов ($<v>)'],
    [/^(?<m>.+) colour mode$/, 'цветовой режим $<m>'],
    [/^(?<c>HEVC|AV1): the system decoder gave no picture for (?<s>\d+) s$/, '$<c>: системный декодер не выдал изображение за $<s> с'],
    [/^(?<c>HEVC|AV1) tile (?<n>\d+)$/, '$<c>, плитка $<n>'],
    [/^PSD compression (?<n>\d+)$/, 'PSD, способ $<n>'],
    [/^PSD version (?<n>\d+)$/, 'версия PSD $<n>'],
    [/^QOI channels (?<n>\d+)$/, 'число каналов QOI: $<n>'],
    [/^iloc field size (?<n>\d+)$/, 'размер поля iloc: $<n>'],
    [/^size (?<v>.+)$/, 'размер $<v>'],
    [/^EXR attribute (?<v>.+)$/, 'атрибут EXR $<v>'],
    // ICNS entries by their four-letter type.
    [/^(?<v>[\w ]{4}) data$/, 'данные $<v>']
  ],
  structureParts: {
    header: 'заголовок',
    'DX10 header': 'заголовок DX10',
    signature: 'сигнатура',
    data: 'данные',
    'image data': 'данные изображения',
    image: 'изображение',
    size: 'размер',
    page: 'страница',
    'has no images': 'без изображений',
    'image size': 'размер изображения',
    'tile size': 'размер плитки',
    'strip offsets': 'смещения полос',
    'bits per sample': 'бит на отсчёт',
    'samples per pixel': 'отсчётов на пиксель',
    'byte order': 'порядок байтов',
    'offset size': 'размер смещений',
    'colour map': 'палитра',
    'colour table': 'палитра',
    layer: 'слой',
    'layer record': 'запись слоя',
    'layer count': 'число слоёв',
    'layer channels': 'каналы слоя',
    'channel list': 'список каналов',
    'chunk count': 'число блоков',
    'data window': 'окно данных',
    'part count': 'число частей',
    'RLE data': 'данные RLE',
    scanline: 'строка',
    'scanline width': 'ширина строки',
    run: 'серия',
    resolution: 'разрешение',
    entries: 'записи',
    entry: 'запись',
    'grid tiles': 'плитки сетки',
    'meta box': 'блок meta',
    'primary image': 'основное изображение',
    'item data': 'данные элемента',
    'item data past the end': 'данные элемента за концом файла',
    'derivation depth': 'глубина производных изображений',
    'identity item': 'элемент iden',
    idat: 'блок idat',
    bitmap: 'битовая карта',
    code: 'код',
    'code table': 'таблица кодов',
    'code length': 'длина кода',
    'data length': 'длина данных'
  },
  valueRules: {
    exposure: [[/(?<n>\d) s\b/, '$<n> с']],
    focalLength: [
      [/^(?<f>[\d.]+) mm \(35 mm equivalent: (?<e>\d+) mm\)$/, '$<f> мм (в пересчёте на 35 мм: $<e> мм)'],
      [/^(?<f>[\d.]+) mm$/, '$<f> мм']
    ],
    flash: RU_FLASH,
    Flash: RU_FLASH,
    altitude: [[/ m$/, ' м']],
    latitude: [
      [/ N$/, ' с. ш.'],
      [/ S$/, ' ю. ш.']
    ],
    longitude: [
      [/ E$/, ' в. д.'],
      [/ W$/, ' з. д.']
    ],
    direction: [[/ magnetic$/, ' (магнитный)']],
    layers: [[/\((?<n>\d+) groups?\)/, (g) => `(${ruCount(g.n, 'группа', 'группы', 'групп')})`]],
    layout: [
      [/^(?<n>\d+) strips? of (?<r>\d+) rows?$/, (g) => `${ruCount(g.n, 'полоса', 'полосы', 'полос')} по ${ruCount(g.r, 'строке', 'строки', 'строк')}`],
      [/^(?<n>\d+) tiles? of (?<s>.+)$/, (g) => `${ruCount(g.n, 'плитка', 'плитки', 'плиток')} ${g.s}`]
    ],
    grid: [[/^(?<c>\d+) × (?<r>\d+) tiles? of (?<s>.+)$/, '$<c> × $<r>, плитки $<s>']],
    pages: [[/\((?<n>\d+) images?\)/, (g) => `(${ruCount(g.n, 'изображение', 'изображения', 'изображений')})`]],
    bitDepth: [
      [/^(?<n>\d+)-bit$/, '$<n> бит'],
      [/^(?<n>\d+) \(float\)$/, '$<n> (с плавающей точкой)'],
      [/ float × /, ' с плавающей точкой × '],
      [/ signed × /, ' со знаком × '],
      [/\(colour map (?<n>\d+)\)/, '(палитра, $<n> бит)'],
      // OpenEXR channel types.
      [/\bhalf\b/g, '16 бит с плавающей точкой'],
      [/\bfloat\b/g, '32 бит с плавающей точкой'],
      [/\buint\b/g, '32 бит без знака']
    ],
    format: [
      [/^(?<n>\d+)-bit$/, '$<n> бит'],
      [/^Bump map (?<n>\d+)-bit$/, 'Карта рельефа, $<n> бит'],
      [/^YUV (?<n>\d+)-bit$/, 'YUV, $<n> бит']
    ],
    compression: [
      [/^code (?<n>\d+)$/, 'код $<n>'],
      [/^JPEG, Baseline$/, 'JPEG, базовый'],
      [/^JPEG, Extended sequential$/, 'JPEG, расширенный последовательный'],
      [/^JPEG, Progressive$/, 'JPEG, прогрессивный'],
      [/^JPEG, Lossless$/, 'JPEG без потерь'],
      [/^JPEG, Arithmetic sequential$/, 'JPEG, арифметический последовательный'],
      [/^JPEG, Arithmetic progressive$/, 'JPEG, арифметический прогрессивный'],
      [/^JPEG, Arithmetic lossless$/, 'JPEG без потерь, арифметический']
    ],
    colorMode: [[/^Mode (?<n>\d+)$/, 'Режим $<n>']],
    extraSamples: [
      [/premultiplied alpha/g, 'предумноженная альфа'],
      [/\balpha\b/g, 'альфа'],
      [/unspecified/g, 'не указано']
    ],
    auxiliary: [
      [/\bAlpha\b/g, 'Альфа'],
      [/\bDepth\b/g, 'Глубина'],
      [/Portrait matte/g, 'Маска портрета'],
      [/Skin matte/g, 'Маска кожи'],
      [/Hair matte/g, 'Маска волос'],
      [/Teeth matte/g, 'Маска зубов'],
      [/Glasses matte/g, 'Маска очков'],
      [/Sky matte/g, 'Маска неба']
    ],
    rotation: [[/ CCW$/, ' против часовой стрелки']],
    orientation: [[/^Normal$/, 'Обычная']],
    Orientation: [[/^Normal$/, 'Обычная']],
    iccDetails: [
      [/· Display ·/, '· Монитор ·'],
      [/· Input ·/, '· Устройство ввода ·'],
      [/· Output ·/, '· Устройство вывода ·'],
      [/· Device link ·/, '· Связь устройств ·'],
      [/· Color space ·/, '· Цветовое пространство ·'],
      [/· Abstract ·/, '· Абстрактный ·'],
      [/· Named color ·/, '· Именованные цвета ·']
    ],
    // OpenEXR tile description (raw attribute and image detail).
    tiles: [
      [/, one level/, ', один уровень'],
      [/, mipmap/, ', MIP-уровни'],
      [/, ripmap/, ', RIP-уровни'],
      [/, rounding up/, ', с округлением вверх'],
      [/, rounding down/, ', с округлением вниз']
    ],
    // OpenEXR channel types in channel lists.
    channels: [
      [/\(half\)/g, '(16 бит)'],
      [/\(float\)/g, '(32 бит)'],
      [/\(uint\)/g, '(32 бит, целые)']
    ],
    // Any key, after the key's own rules: byte counts and units.
    '*': [
      [/(?<n>\d+) bytes$/, (g) => ruCount(g.n, 'байт', 'байта', 'байт')],
      [/(?<n>\d) mm\b/g, '$<n> мм'],
      [/(?<n>\d) m$/, '$<n> м'],
      [/(?<n>\d) s$/, '$<n> с'],
      [/^(?<n>[34]×[34]) matrix$/, 'матрица $<n>'],
      [/ \(unreadable\)$/, ' (не читается)']
    ],
    subfile: [
      [/reduced resolution/, 'уменьшенное разрешение'],
      [/page of a multi-page image/, 'страница многостраничного изображения'],
      [/transparency mask/, 'маска прозрачности']
    ],
    printSize: [
      [/ in$/, ' дюйм.'],
      [/ cm$/, ' см']
    ],
    resolution: [
      [/ (ppi|dpi)$/, ' пикс./дюйм'],
      [/ px\/cm$/, ' пикс./см']
    ],
    colorSpace: [
      [/(?<v>\S+) primaries/, 'основные цвета $<v>'],
      [/(?<v>\S+) transfer/, 'передаточная функция $<v>'],
      [/(?<v>\S+) matrix/, 'матрица $<v>'],
      [/full range/, 'полный диапазон'],
      [/video range/, 'видеодиапазон']
    ],
    speed: [
      [/ km\/h$/, ' км/ч'],
      [/ mph$/, ' миль/ч'],
      [/ knots$/, ' уз']
    ]
  },
  units: { b: 'Б', kb: 'КБ', mb: 'МБ', gb: 'ГБ' }
}

/** Strings for a BCP-47 tag: Russian for `ru*`, English otherwise. */
export function stringsFor(locale: string | undefined): Strings {
  return (locale ?? '').toLowerCase().startsWith('ru') ? ru : en
}

/** Fills `{name}` placeholders. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** An entry of the table itself, never an inherited one: file text can be "constructor". */
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

export function label(t: Strings, key: string): string {
  return own(t.labels as Record<string, string>, key) ?? key
}

export function sectionTitle(t: Strings, title: string): string {
  return own(t.sections as Record<string, string>, title) ?? title
}

export function valueText(t: Strings, value: string): string {
  return own(t.values as Record<string, string>, value) ?? value
}

/** Info keys whose values are text from the file (names, credits, notes): never translated. */
const FILE_TEXT = new Set(['name', 'software', 'copyright', 'camera', 'serial', 'pageName', 'model', 'lens', 'job', 'description', 'comment', 'author', 'artist', 'iccProfile', 'imageId', 'noData', 'view'])

export function isFileText(key: string): boolean {
  return FILE_TEXT.has(key)
}

type LabelKey = keyof Strings['imageLabels']

/** What the decoders write into image labels, one `·`-separated segment at a time. */
const LABEL_PATTERNS: [RegExp, LabelKey, ...string[]][] = [
  [/^Page (\d+) \(reduced\)$/, 'pageReduced', 'n'],
  [/^Page (\d+)$/, 'page', 'n'],
  [/^sub-image (\d+)$/, 'subImage', 'n'],
  [/^Layer (\d+)$/, 'layer', 'n'],
  [/^Mip (\d+)$/, 'mip', 'n'],
  [/^Slice (\d+)$/, 'slice', 'n'],
  [/^level (\d+(?:, \d+)?)$/, 'level', 'n'],
  [/^Dark$/, 'dark'],
  [/^Largest preview$/, 'largestPreview'],
  [/^Preview$/, 'preview'],
  [/^Thumbnail$/, 'thumbnail'],
  [/^Thumbnail (\d+×\d+)$/, 'thumbnailSize', 'size'],
  [/^Thumbnail of (\d+) (\d+×\d+)$/, 'thumbnailOf', 'n', 'size'],
  [/^Primary image$/, 'primary'],
  [/^Image$/, 'image'],
  [/^Image (\d+)$/, 'imageN', 'n'],
  [/^Composite$/, 'composite'],
  [/^Deep image$/, 'deep'],
  [/^Empty$/, 'empty'],
  [/^Alpha$/, 'alpha'],
  [/^Depth$/, 'depth'],
  [/^Portrait matte$/, 'portraitMatte'],
  [/^HDR gain map$/, 'gainMap'],
  [/^Skin matte$/, 'skinMatte'],
  [/^Hair matte$/, 'hairMatte'],
  [/^Teeth matte$/, 'teethMatte'],
  [/^Glasses matte$/, 'glassesMatte'],
  [/^Sky matte$/, 'skyMatte'],
  [/^deep data$/, 'deepData'],
  [/^no channels$/, 'noChannels'],
  [/^(\S+) compression$/, 'compression', 'name']
]

/**
 * An image label or "cannot be shown" reason in the UI language. Only whole segments the
 * decoders generate are translated; names from the file (EXR parts, PSD layers) stay as they are.
 */
export function imageText(t: Strings, text: string): string {
  if (t === en) return text
  return text
    .split(' · ')
    .map((segment) => {
      for (const [pattern, key, ...names] of LABEL_PATTERNS) {
        const m = pattern.exec(segment)
        if (m) return fill(t.imageLabels[key], Object.fromEntries(names.map((n, i) => [n, m[i + 1]])))
      }
      return segment
    })
    .join(' · ')
}

/** A second line under an error message, when there is something the user can check. */
export function errorHint(t: Strings, code: string, detail: string): string {
  return code === 'no-video-decoder' && detail === 'HEVC' ? t.hevcHint : ''
}

/** An error's detail in the UI language; English details are shown as made. */
export function errorDetail(t: Strings, detail: string): string {
  const whole = own(t.errorDetails, detail)
  if (whole) return whole
  for (const [pattern, replacement] of t.errorRules) if (pattern.test(detail)) return detail.replace(pattern, replacement)
  const m = /^(TIFF|BigTIFF|PSD|EXR|DDS|ICNS|HEIF|TGA|QOI|Radiance|PIZ|B44|PXR24) (.+)$/.exec(detail)
  const part = m && own(t.structureParts, m[2])
  if (m && part) return `${part} ${m[1]}`
  return detail
}

/** An error as one sentence; without a detail, the parenthesis that would hold it goes too. */
export function describeError(error: unknown, t: Strings): string {
  if (error instanceof ImageError) {
    const template = own(t.errors as Record<string, string>, error.code) ?? t.errors['decode-failed']
    const detail = errorDetail(t, error.detail)
    return fill(detail ? template : template.replace(/\s*\([^()]*\{detail\}[^()]*\)/g, ''), { detail })
  }
  return fill(t.errors['decode-failed'], { detail: error instanceof Error ? error.message : String(error) })
}

/** An info value in the UI language: whole known values, then the key's rewrite rules. */
export function infoValue(t: Strings, key: string, value: string): string {
  if (FILE_TEXT.has(key)) return value
  let out = rewrite(own(t.valueRules, key), value)
  if (out === value) out = valueText(t, value)
  return rewrite(own(t.valueRules, '*'), out)
}

function rewrite(rules: Rule[] | undefined, value: string): string {
  let out = value
  for (const [pattern, replacement] of rules ?? []) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, (...args) => replacement(args[args.length - 1] as Record<string, string>))
  }
  return out
}

export function formatSize(bytes: number, locale: string, units: Strings['units']): string {
  const fmt = (n: number, d: number) => n.toLocaleString(locale, { maximumFractionDigits: d })
  if (bytes < 1024) return `${fmt(bytes, 0)} ${units.b}`
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024, 1)} ${units.kb}`
  if (bytes < 1024 ** 3) return `${fmt(bytes / 1024 / 1024, 1)} ${units.mb}`
  return `${fmt(bytes / 1024 ** 3, 2)} ${units.gb}`
}
