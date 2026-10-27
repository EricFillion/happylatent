"""Source-pixel crop geometry shared by preview and conditioning."""
from .project import ValidationError, validate_crop


def crop_rectangle(source_width, source_height, output_width, output_height, x=0.5, y=0.5, scale=1):
    """Return left, top, width, height; position is a fraction of available travel.

    Preserve the centered fill's pixel extent when repositioning it. Nearest-even
    rounding keeps centered results compatible with ComfyUI's image resize.
    """
    dimensions = (source_width, source_height, output_width, output_height)
    if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in dimensions):
        raise ValidationError("Image and output dimensions must be positive integers.")
    position = validate_crop({"x": x, "y": y, "scale": scale})
    source_ratio, output_ratio = source_width / source_height, output_width / output_height
    fractions = (min(1, output_ratio / source_ratio), min(1, source_ratio / output_ratio))
    source = (source_width, source_height)
    travel = [2 * round((length - length * fraction) / 2) for length, fraction in zip(source, fractions)]
    retained = [length - extra for length, extra in zip(source, travel)]
    if min(retained) <= 0:
        raise ValidationError("The image is too narrow for this output shape.")
    retained = [max(1, round(length * position["scale"])) for length in retained]
    travel = [length - kept for length, kept in zip(source, retained)]
    return (round(travel[0] * position["x"]), round(travel[1] * position["y"]), *retained)
