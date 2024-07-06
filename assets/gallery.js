        function toggleImages(element) {
            var imagesDiv = element.nextElementSibling;
            if (imagesDiv.style.display === "none" || imagesDiv.style.display === "") {
                imagesDiv.style.display = "block";
            } else {
                imagesDiv.style.display = "none";
            }
        }
