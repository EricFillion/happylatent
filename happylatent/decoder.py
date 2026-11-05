"""Bound large CUDA LTX diffusion-decoder normalization without tiling video."""
from contextlib import contextmanager
from threading import RLock


# Keep individual calls well below 32-bit element-index limits. PyTorch 2.10
# CUDA RMSNorm silently corrupts the tail of the 4.57-billion-element tensor
# produced by the LTX diffusion decoder at 121 frames and 2048x1152.
_MAX_NORM_ELEMENTS = 1 << 30
_NORMALIZATION_LOCK = RLock()


def _normalize_bounded(x, forward, max_elements=_MAX_NORM_ELEMENTS):
    """Split token axes only; each complete channel vector uses the same norm."""
    if x.numel() <= max_elements:
        return forward(x)
    import torch

    # Preserve arbitrary strides and batches without flattening/copying the
    # entire activation or ever splitting the normalized channel dimension.
    axis = next((i for i in range(x.ndim - 1) if x.shape[i] > 1), None)
    if axis is None:
        raise ValueError("A single normalization vector exceeds the decoder limit")
    chunk = max(1, max_elements // (x.numel() // x.shape[axis]))
    result = torch.empty_like(x)
    for start in range(0, x.shape[axis], chunk):
        length = min(chunk, x.shape[axis] - start)
        result.narrow(axis, start, length).copy_(
            _normalize_bounded(x.narrow(axis, start, length), forward, max_elements))
    return result


@contextmanager
def bounded_ltx_cuda_normalization(vae):
    """Guard only the known LTX decoder during this native CUDA decode.

    No shared ComfyUI class, kernel, weights, precision or sampling defaults
    change. Restore the instance even when native decoding retries or raises.
    """
    if getattr(getattr(vae, "device", None), "type", None) != "cuda":
        yield
        return
    try:
        from comfy.ldm.lightricks.vae.na_diffusion_decoder import CausalDiffusionVAE, RMSNorm
    except ImportError:
        # Older hosts do not contain this decoder architecture.
        yield
        return
    model = getattr(vae, "first_stage_model", None)
    if type(model) is not CausalDiffusionVAE:
        yield
        return
    norm = getattr(getattr(model, "decoder", None), "norm_out", None)
    if type(norm) is not RMSNorm:
        yield
        return
    with _NORMALIZATION_LOCK:
        original = norm.forward
        if getattr(original, "__func__", None) is not RMSNorm.forward:
            # A third-party override has its own contract.
            yield
            return
        had_instance_forward = "forward" in norm.__dict__
        norm.forward = lambda x: _normalize_bounded(x, original)
        try:
            yield
        finally:
            if had_instance_forward:
                norm.forward = original
            else:
                del norm.forward
