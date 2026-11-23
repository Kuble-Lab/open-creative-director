# A guest character in a HUD video
Wire a second character sheet into the image steps while keeping the lead's lip sync.

1. Use `get_workflow` with include_graph and `list_node_types` before `edit_workflow`. In the HUD templates n33 is the lead's input.influencer; n4 is music_video.hud_plan; n5 is its image.generate character sheet. Keep these lead connections and n12 (fal.h3_lipsync).
2. Add another input.influencer with its influencer parameter set to the guest ID from `list_influencers` / `get_influencer`. Its figure output is text; images is a list of saved reference images.
3. Add a text.template node for a guest-only character-sheet prompt (template text plus {{a}}), connecting the guest's figure to a. Add image.generate with aspect_ratio: "3:4", count: 1 and a reference-capable model. Connect the text.template text output to prompt and the guest images output to images. This makes a separate guest sheet.
4. Keep n5.image connected first to images on n9, n10 and n11 (image.edit). Add the guest sheet's image output as the second connection on each of these images inputs. These ports accept multiple images, collected in connection order, subject to the chosen model's reference limit. Both image.generate and image.edit accept reference-image lists.
5. Change the template parameter of n6/n7/n8 (text.template) to identify reference 1 as the lead and reference 2 as the guest, retaining {{a}} for the scene prompt. In n4's brief explicitly name both roles, their appearance and where the guest should appear. These are prompt instructions, not a guarantee that generated pictures preserve identity; inspect the images before approval.
6. Keep the lead's sung lines outside parentheses. Put guest/backing lines in whole-line parentheses alongside lead lines, or explicitly mark a guest-only section [Choir]. Read `get_guide` topic hud-music-video for the all-parentheses section exception. Choir lines receive no lead lip sync; this graph does not add a second lip-sync performer.
7. Use `estimate_run`, obtain cost approval, then `run_workflow`; inspect sheets and scenes with `get_workflow_results` before approving the remaining video.

Use edit operations add_node (with a ref), connect (from/to node and port) and set_params; references to new nodes can be used within the same edit call. No app code change is needed for these graph connections.
